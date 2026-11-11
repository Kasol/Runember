/**
 * agentdesk · M0 探针
 *
 * 一次性验证这个项目全部的技术假设，四道关卡：
 *   P1  容器化执行  —— runner 镜像里 codex CLI 可运行，workspace 卷可初始化为 git 仓库
 *   P2  事件流      —— codex exec --json 的 JSONL 逐行可解析（顺便摸清事件类型清单）
 *   P3  会话持久化  —— sessions 落在 codex-home 卷里，跨容器可见
 *   P4  resume 续跑 —— 新容器 codex exec resume <session> 带反馈，上下文延续（暗号验证）
 *
 * 运行位置：探针容器内（挂 /var/run/docker.sock），通过 dockerode 派生兄弟 Runner 容器。
 * 这与生产 daemon 的拓扑完全一致 —— 探针通过 = 生产路径通过。
 *
 * 用法: tsx scripts/m0-probe.ts [--offline] [--reset] [--timeout-min N]
 * 退出码: 0=全部通过  1=有失败  2=因缺 KEY 跳过在线阶段
 */
import Docker from 'dockerode';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { join, resolve } from 'node:path';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const OFFLINE = argv.includes('--offline');
const RESET = argv.includes('--reset');
const TIMEOUT_MIN = (() => {
  const i = argv.indexOf('--timeout-min');
  return i >= 0 ? Number(argv[i + 1]) || 8 : 8;
})();

const IMAGE_RUNNER = process.env.IMAGE_RUNNER ?? 'agentdesk/runner-codex:m0';
const VOL_WS = 'agentdesk-m0-workspace';
const VOL_HOME = 'agentdesk-m0-codex-home';
const DATA_DIR = resolve('data', 'm0');
const API_KEY = (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || '').trim();

// ---------- 任务指令 ----------
const TASK1 = [
  '这是一次无人值守链路的连通性测试，请严格按步骤执行：',
  '1. 在 /workspace 下创建文件 note.md，第一行内容为：M0-PHASE1-OK',
  '2. 记住暗号 MELON-42，稍后我会向你追问。',
  '3. 不要执行 git commit，不要修改其他文件。',
  '完成后用一句话回复即可。',
].join('\n');

const TASK2 = [
  '继续之前的测试：请把你记住的暗号写入 /workspace/note.md 的第二行，',
  '格式为 SECRET:暗号。只做这一件事，不要执行 git commit。',
].join('\n');

const INIT_WS = [
  'git init -q 2>/dev/null || true',
  'git config user.email m0@agentdesk.local',
  'git config user.name agentdesk-m0',
  "echo '# agentdesk M0 workspace' > README.md",
  'git add -A',
  "git commit -qm init 2>/dev/null || echo 'repo-already-initialized'",
  'git log --oneline -1',
].join(' && ');

const INSPECT_HOME = [
  "echo '--- /codex-home ---'",
  'ls -la /codex-home 2>/dev/null || echo "(missing)"',
  "echo '--- all *.jsonl under /codex-home ---'",
  "find /codex-home -type f -name '*.jsonl' 2>/dev/null | sort",
  "echo '--- /root/.codex（应为空，否则 CODEX_HOME 未生效） ---'",
  'ls -la /root/.codex 2>/dev/null || echo "(absent)"',
].join('\n');

// ---------- 结果收集 ----------
interface Check { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; detail?: string }
const checks: Check[] = [];
const record = (name: string, status: Check['status'], detail = '') => {
  checks.push({ name, status, detail });
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏭️ ';
  console.log(`${icon} [${status}] ${name}${detail ? ' — ' + detail : ''}`);
};
const banner = (s: string) => console.log(`\n━━━ ${s} ━━━`);

// ---------- 基础工具 ----------
function lineSink(onLine: (line: string) => void): Writable {
  let buf = '';
  return new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r+$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim()) onLine(line);
      }
      cb();
    },
    final(cb) { if (buf.trim()) onLine(buf); cb(); },
  });
}

async function ensureVolumes(): Promise<void> {
  for (const name of [VOL_WS, VOL_HOME]) {
    try { await docker.getVolume(name).inspect(); }
    catch { await docker.createVolume({ Name: name }); }
  }
}
async function purgeVolumes(): Promise<void> {
  for (const name of [VOL_WS, VOL_HOME]) {
    try {
      await docker.getVolume(name).remove({ force: true });
      console.log(`   已删除卷 ${name}`);
    } catch { /* 不存在则忽略 */ }
  }
}

interface RunResult { exitCode: number; killed: boolean; out: string[]; err: string[] }

/** 探针自身的代理环境透传给 runner 容器（国内访问 openai 必需） */
function passthroughProxyEnv(): string[] {
  const vars: string[] = [];
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']) {
    const v = process.env[k];
    if (v) vars.push(`${k}=${v}`);
  }
  return vars;
}
const PROXY_ENV = passthroughProxyEnv();

/** 在 Runner 镜像里起一个一次性容器执行命令，收集 stdout/stderr，超时强杀 */
async function runInRunner(opts: {
  tag: string;
  cmd: string[];
  env?: string[];
  timeoutMs: number;
  logFile?: string;
  onStdoutLine?: (line: string) => void;
}): Promise<RunResult> {
  const { tag, cmd, env = [], timeoutMs, logFile, onStdoutLine } = opts;
  const out: string[] = [];
  const err: string[] = [];
  if (logFile) writeFileSync(logFile, `# ${new Date().toISOString()} cmd: ${cmd.join(' ')}\n`);

  const container = await docker.createContainer({
    Image: IMAGE_RUNNER,
    Cmd: cmd,
    Env: [...env, 'CODEX_HOME=/codex-home', ...PROXY_ENV],
    WorkingDir: '/workspace',
    Labels: { 'agentdesk.m0': tag },
    AttachStdout: true,
    AttachStderr: true,
    HostConfig: {
      Binds: [`${VOL_WS}:/workspace`, `${VOL_HOME}:/codex-home`],
      // codex 的 workspace-write 沙箱在 Linux 用 bwrap（需要 unprivileged userns），
      // Docker 默认 seccomp 会禁掉 clone(CLONE_NEWUSER) 导致 agent 全部命令执行失败。
      // 放开 seccomp：外层隔离仍由一次性容器边界承担（本架构的既定设计）。
      SecurityOpt: ['seccomp=unconfined'],
    },
  });

  const short = cmd.map(c => (c.length > 60 ? c.slice(0, 57) + '…' : c)).join(' ');
  console.log(`   ▶ ${tag}: ${short}`);
  await container.start();

  const stream = await container.logs({ follow: true, stdout: true, stderr: true });
  docker.modem.demuxStream(
    stream,
    lineSink(l => { out.push(l); if (logFile) appendFileSync(logFile, l + '\n'); onStdoutLine?.(l); }),
    lineSink(l => { err.push(l); if (logFile) appendFileSync(logFile, '[stderr] ' + l + '\n'); }),
  );

  let killed = false;
  const timer = setTimeout(() => { killed = true; void container.kill().catch(() => {}); }, timeoutMs);
  const wait = await container.wait();
  clearTimeout(timer);
  try { (stream as any).destroy?.(); } catch { /* 已结束 */ }
  try { await container.remove(); } catch { /* 尽力清理 */ }

  return { exitCode: wait.StatusCode ?? -1, killed, out, err };
}

// ---------- codex --json 事件解析（宽容式：M0 的任务之一就是摸清事件清单） ----------
interface ExecStats { types: Set<string>; ids: Set<string>; agentText: string[]; jsonLines: number }
function makeCollector(): { onLine: (l: string) => void; stats: ExecStats } {
  const stats: ExecStats = { types: new Set(), ids: new Set(), agentText: [], jsonLines: 0 };
  return {
    stats,
    onLine(line) {
      if (!line.startsWith('{')) return;
      try {
        const o = JSON.parse(line) as any;
        stats.jsonLines++;
        const msg = o?.msg ?? o;
        if (typeof msg?.type === 'string') stats.types.add(msg.type);
        for (const key of ['session_id', 'thread_id', 'conversation_id']) {
          const v = msg?.[key] ?? o?.[key];
          if (typeof v === 'string' && v.length >= 16) stats.ids.add(v);
        }
        const item = msg?.item;
        if (msg?.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
          stats.agentText.push(item.text);
        }
      } catch { /* 非 JSON 行（如 codex 的提示语）忽略 */ }
    },
  };
}

// ---------- 主流程 ----------
const docker = new Docker(); // 容器内默认连 /var/run/docker.sock

async function main(): Promise<number> {
  mkdirSync(DATA_DIR, { recursive: true });
  const startedAt = new Date().toISOString();

  banner('P0 · 环境自检');
  try {
    await docker.ping();
    record('P0 docker daemon 可达', 'PASS');
  } catch (e) {
    record('P0 docker daemon 可达', 'FAIL', String(e));
    console.error('\n提示：探针应在容器内运行（npm run m0），socket 已由 m0.sh 挂载。');
    return 1;
  }
  try {
    const img = await docker.getImage(IMAGE_RUNNER).inspect();
    record('P0 runner 镜像存在', 'PASS', (img.RepoTags ?? []).join(',') || IMAGE_RUNNER);
  } catch {
    record('P0 runner 镜像存在', 'FAIL', `缺少 ${IMAGE_RUNNER}，先跑 npm run m0`);
    return 1;
  }
  if (RESET) { console.log('   --reset: 清理旧卷...'); await purgeVolumes(); }
  await ensureVolumes();

  banner('P1 · 初始化 workspace 卷（git 仓库）');
  const init = await runInRunner({
    tag: 'init-ws',
    cmd: ['/bin/sh', '-c', INIT_WS],
    timeoutMs: 90_000,
    logFile: join(DATA_DIR, 'p1-init.log'),
  });
  record('P1 workspace 初始化为 git 仓库', init.exitCode === 0 ? 'PASS' : 'FAIL',
    init.out.slice(-1)[0] ?? init.err.slice(-1)[0] ?? '');

  banner('P2 · runner 镜像内 codex 可执行');
  const ver = await runInRunner({ tag: 'codex-version', cmd: ['codex', '--version'], timeoutMs: 60_000 });
  record('P2 codex --version', ver.exitCode === 0 ? 'PASS' : 'FAIL', ver.out[0] ?? ver.err[0] ?? '');

  banner('P2.5 · 认证检测（API key 或订阅 auth.json）');
  const auth = await runInRunner({
    tag: 'auth-check',
    cmd: ['/bin/sh', '-c', 'test -f /codex-home/auth.json && echo HAS_AUTH_JSON || echo NO_AUTH_JSON'],
    timeoutMs: 30_000,
  });
  const hasAuthJson = auth.out[0] === 'HAS_AUTH_JSON';
  const authMode = API_KEY ? 'API key（环境变量）' : hasAuthJson ? 'ChatGPT 订阅登录（auth.json）' : '';
  record('P2.5 存在可用认证', authMode ? 'PASS' : 'SKIP', authMode || '无 key 也无 auth.json');

  if (OFFLINE) {
    record('P3 codex exec --json 无值守执行', 'SKIP', '离线模式');
    record('P4 codex-home 会话持久化', 'SKIP', '离线模式');
    record('P5 新容器 resume 续跑', 'SKIP', '离线模式');
    record('P6 上下文延续断言（暗号）', 'SKIP', '离线模式');
    console.log('\n离线冒烟结束。填好 CODEX_API_KEY 后跑: npm run m0');
    return finish(startedAt, false);
  }

  if (!authMode) {
    record('P3+ 在线阶段', 'SKIP', '缺认证：.env 填 CODEX_API_KEY，或先跑 npm run m0:login');
    console.log('\n认证二选一：\n  1) .env 填 CODEX_API_KEY（按量付费）\n  2) npm run m0:login（ChatGPT Plus/Pro 订阅，设备码登录）');
    return finish(startedAt, false, 2);
  }
  const KEY_ENV = API_KEY ? [`CODEX_API_KEY=${API_KEY}`] : [];
  const tmo = TIMEOUT_MIN * 60_000;

  banner('P3 · codex exec --json 无值守执行');
  const c1 = makeCollector();
  const r1 = await runInRunner({
    tag: 'exec-task1',
    cmd: ['codex', 'exec', '--json', '--sandbox', 'workspace-write', TASK1],
    env: KEY_ENV,
    timeoutMs: tmo,
    logFile: join(DATA_DIR, 'p3-exec.jsonl.log'),
    onStdoutLine: c1.onLine,
  });
  record('P3 退出码 0（未被超时击杀）', r1.exitCode === 0 && !r1.killed ? 'PASS' : 'FAIL',
    `exit=${r1.exitCode} killed=${r1.killed}`);
  record('P3 JSONL 事件流可解析', c1.stats.jsonLines > 0 ? 'PASS' : 'FAIL',
    `json行=${c1.stats.jsonLines}；类型=[${[...c1.stats.types].join(', ')}]`);
  if (c1.stats.agentText.length) {
    console.log(`   agent 最终回复: ${c1.stats.agentText.at(-1)!.slice(0, 120)}`);
  }

  banner('P4 · codex-home 卷会话持久化');
  const insp = await runInRunner({
    tag: 'inspect-home',
    cmd: ['/bin/sh', '-c', INSPECT_HOME],
    timeoutMs: 60_000,
    logFile: join(DATA_DIR, 'p4-inspect.log'),
  });
  const sessionFiles = insp.out.filter(l => /\.jsonl$/.test(l));
  record('P4 sessions 落在卷内', sessionFiles.length > 0 ? 'PASS' : 'FAIL',
    `${sessionFiles.length} 个会话文件`);
  const rootLeak = insp.out.filter(l => l.includes('/root/.codex')).length;
  if (rootLeak > 1) console.log('   ⚠️ /root/.codex 有内容——CODEX_HOME 可能未生效，看 p4-inspect.log');
  const fallbackId = (() => {
    const m = [...sessionFiles.join('\n').matchAll(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/g)];
    return m.at(-1)?.[1];
  })();
  const sessionId = c1.stats.ids.values().next().value ?? fallbackId;
  record('P4 提取到 session id', sessionId ? 'PASS' : 'FAIL',
    `事件流=${c1.stats.ids.size}个候选，文件名兜底=${fallbackId ? '有' : '无'}，采用=${sessionId ?? '无'}`);

  banner('P5 · 新容器 exec resume 续跑');
  const resumeTarget = sessionId ?? '--last';
  const c2 = makeCollector();
  const r2 = await runInRunner({
    tag: 'resume-task2',
    cmd: ['codex', 'exec', 'resume', ...(sessionId ? [sessionId] : ['--last']), '--json', TASK2],
    env: KEY_ENV,
    timeoutMs: tmo,
    logFile: join(DATA_DIR, 'p5-resume.jsonl.log'),
    onStdoutLine: c2.onLine,
  });
  record('P5 resume 退出码 0', r2.exitCode === 0 && !r2.killed ? 'PASS' : 'FAIL',
    `exit=${r2.exitCode} killed=${r2.killed} target=${resumeTarget}`);

  banner('P6 · 断言：上下文延续（暗号）');
  const cat = await runInRunner({
    tag: 'verify-note',
    cmd: ['/bin/sh', '-c', 'cat /workspace/note.md'],
    timeoutMs: 30_000,
  });
  const content = cat.out.join('\n');
  record('P6 note.md 含 P1 写入', content.includes('M0-PHASE1-OK') ? 'PASS' : 'FAIL', JSON.stringify(content.slice(0, 200)));
  record('P6 暗号续写成功（resume 上下文延续）', /SECRET:\s*MELON-42/.test(content) ? 'PASS' : 'FAIL', '');

  return finish(startedAt, true);
}

/** 汇总落盘 + 打印结论，返回退出码 */
function finish(startedAt: string, online: boolean, forced = 0): number {
  const failed = checks.filter(c => c.status === 'FAIL').length;
  writeFileSync(join(DATA_DIR, 'summary.json'), JSON.stringify({
    startedAt, finishedAt: new Date().toISOString(),
    online, image: IMAGE_RUNNER, checks,
  }, null, 2));

  console.log('\n━━━ M0 结论 ━━━');
  for (const c of checks) console.log(`  ${c.status.padEnd(4)} ${c.name}${c.detail ? '  (' + c.detail + ')' : ''}`);
  console.log(`\n明细见 data/m0/（*.log 为原始输出，summary.json 为结构化结论）`);
  if (forced) return forced;
  return failed > 0 ? 1 : 0;
}

main()
  .then(code => process.exit(code))
  .catch(e => { console.error('探针异常:', e); process.exit(1); });
