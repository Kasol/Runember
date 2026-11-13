/**
 * Runner —— 单个 Run 的生命周期管家（M0 探针验证过的全部运维知识都在这）：
 *   host-dir 模式：bind mount 用户真实项目目录 + 任务前 checkpoint commit（安全网）
 *   seccomp=unconfined：codex 的 bwrap 沙箱需要 userns（M0 实测硬要求）
 *   codex-home 卷：凭证 + 会话，跨容器 resume 的命脉
 *   事件流：adapter 解析 → jsonl 落盘 + session id + 末条 agent 消息
 *   收尾：git 改动清单 + diffstat → RunSummary；classifyRun 判终态
 */
import Docker from 'dockerode';
import { Writable } from 'node:stream';
import { appendFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { classifyRun, taskStatusAfterRun, AGENTCTL_MARKER } from '@agentdesk/core';
import { getAdapterId } from './util.js';
import { hostCheckpoint, hostAudit } from './hostgit.js';
import { renderMcpToml, writeMcpToVolume } from './mcp.js';
import { runNative } from './native.js';
import type { Task, Project, RunSummary } from '@agentdesk/core';

export interface RunnerDeps {
  docker: Docker;
  cfg: import('./config.js').AppConfig;
  store: import('./store.js').Store;
  events: import('./notify.js').EventBus;
}

interface SpawnResult { exitCode: number; killed: boolean; out: string[]; err: string[] }

/** Windows 绝对路径 → docker bind 格式（正斜杠） */
function toBind(path: string): string {
  return path.replace(/\\/g, '/');
}

function lineSink(onLine: (l: string) => void): Writable {
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

export class Runner {
  constructor(private deps: RunnerDeps) {}

  private getSpawnBinds(project: Project, agentHomeVolume: string): string[] {
    return [
      `${toBind(project.workspace_path)}:/workspace`,
      `${agentHomeVolume}:/codex-home`,
    ];
  }

  /** 一次性容器执行命令（与生产语义一致：超时杀、用完删） */
  private async spawn(opts: {
    image: string; cmd: string[]; binds: string[]; env: string[];
    timeoutMs: number; tag: string; onStdoutLine?: (l: string) => void;
  }): Promise<SpawnResult> {
    const { docker } = this.deps;
    const out: string[] = [];
    const err: string[] = [];
    const container = await docker.createContainer({
      Image: opts.image,
      Cmd: opts.cmd,
      Env: opts.env,
      WorkingDir: '/workspace',
      Labels: { 'agentdesk.run': opts.tag },
      AttachStdout: true,
      AttachStderr: true,
      // codex 会在 stdin 打开时等待输入（"Reading additional input from stdin"），
      // 任务完成后不退出 → 状态滞后。显式关闭 stdin 让其立即结束。
      OpenStdin: false,
      StdinOnce: false,
      AttachStdin: false,
      HostConfig: {
        Binds: opts.binds,
        SecurityOpt: ['seccomp=unconfined'], // bwrap 需要 userns（M0 实测）
      },
    });
    await container.start();
    const stream = await container.logs({ follow: true, stdout: true, stderr: true });
    docker.modem.demuxStream(
      stream,
      lineSink(l => { out.push(l); opts.onStdoutLine?.(l); }),
      lineSink(l => err.push(l)),
    );
    let killed = false;
    const timer = setTimeout(() => { killed = true; void container.kill().catch(() => {}); }, opts.timeoutMs);
    const wait = await container.wait();
    clearTimeout(timer);
    try { (stream as any).destroy?.(); } catch { /* noop */ }
    try { await container.remove(); } catch { /* noop */ }
    return { exitCode: wait.StatusCode ?? -1, killed, out, err };
  }

  private proxyEnv(): string[] {
    const { proxy } = this.deps.cfg;
    const env: string[] = [];
    if (proxy.httpsProxy) env.push(`HTTPS_PROXY=${proxy.httpsProxy}`, `https_proxy=${proxy.httpsProxy}`);
    if (proxy.httpProxy) env.push(`HTTP_PROXY=${proxy.httpProxy}`, `http_proxy=${proxy.httpProxy}`);
    return env;
  }

  private async ensureVolume(name: string): Promise<void> {
    const { docker } = this.deps;
    try { await docker.getVolume(name).inspect(); }
    catch { await docker.createVolume({ Name: name }); }
  }

  /**
   * 播种宿主 skills → codex-home 卷（单向覆盖，宿主是 source of truth）。
   * 让容器内 codex 继承宿主 GUI/CLI 的全局 skills（如 git-dev-flow 等）。
   * 宿主 skills 目录位置可配置（agents.<id>.hostSkillsDir），默认 ~/.codex/skills。
   */
  private async seedSkills(volumeName: string): Promise<void> {
    const { cfg, docker } = this.deps;
    const hostSkills = cfg.agents['codex']?.hostSkillsDir;
    if (!hostSkills || !existsSync(hostSkills)) return;

    await this.ensureVolume(volumeName);
    const sower = await docker.createContainer({
      Image: 'alpine:latest',
      Cmd: ['sh', '-c', 'mkdir -p /codex-home/skills && cp -r /host-skills/. /codex-home/skills/'],
      HostConfig: {
        Binds: [`${toBind(hostSkills)}:/host-skills:ro`, `${volumeName}:/codex-home`],
        AutoRemove: true,
      },
      Labels: { 'agentdesk.seed': 'skills' },
    });
    await sower.start();
    await sower.wait();
    console.log(`🌱 已播种宿主 skills → ${volumeName}`);
  }

  /**
   * 项目级依赖预装（依赖三层通道的"项目层"）：
   * extraPackages 声明的系统包 → 装完 commit 为项目专属镜像（<base>-p<projectId>）。
   * 镜像按内容键复用：同名包集合同一镜像，不随 run 数膨胀。
   */
  private async installPackages(baseImage: string, packages: string[], projectId: number): Promise<string> {
    const { docker } = this.deps;
    const key = packages.slice().sort().join(',');
    const target = `${baseImage.split(':')[0]}:p${projectId}`;
    // 复用：目标镜像已存在则跳过安装（包集合变化时由调用方传不同 packages，tag 以项目为粒度，
    // 变更场景：先删旧 tag 再重建——简单可靠，容器销毁型架构下重建成本可接受）
    try { await docker.getImage(target).inspect(); return target; } catch { /* 不存在，开始构建 */ }
    const c = await docker.createContainer({
      Image: baseImage,
      Cmd: ['sh', '-c', `apt-get update -qq && apt-get install -y -qq --no-install-recommends ${packages.join(' ')} && rm -rf /var/lib/apt/lists/*`],
      Labels: { 'agentdesk.extra': 'pkgs', 'agentdesk.packages': key },
    });
    await c.start();
    const wait = await c.wait();
    if (wait.StatusCode !== 0) {
      try { await c.remove({ force: true }); } catch { /* noop */ }
      throw new Error(`依赖预装失败（exit=${wait.StatusCode}）: ${packages.join(',')}`);
    }
    await c.commit({ repo: target.split(':')[0], tag: target.split(':')[1] });
    try { await c.remove(); } catch { /* noop */ }
    console.log(`📦 项目依赖镜像就绪: ${target} (${packages.join(', ')})`);
    return target;
  }
  /** Native 路径：codex 直接跑宿主（无容器）。与 Docker 路径产出同构的 SpawnResult */
  private async runNativePath(opts: {
    adapterImage: string; cmd: string[]; cwd: string; env: string[];
    timeoutMs: number; tag: string; onStdoutLine?: (l: string) => void;
  }): Promise<{ exitCode: number; killed: boolean; out: string[]; err: string[] }> {
    // 宿主命令映射：容器内是 'codex ...'，宿主 PATH 上也是 codex（CLI 原生安装）
    const cmd = opts.cmd[0] === 'codex' ? ['codex', ...opts.cmd.slice(1)] : opts.cmd;
    return runNative({
      cmd, cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs,
      onStdoutLine: opts.onStdoutLine,
    });
  }

  async execute(taskId: number): Promise<void> {
    const { cfg, store, events } = this.deps;
    const task = store.getTask(taskId)!;
    const project = store.getProject(task.project_id)!;
    const adapter = getAdapterId(project.agent_id, cfg);
    const agentCfg = cfg.agents[project.agent_id]!;
    const runsDir = join(cfg.dataDir, 'runs');
    mkdirSync(runsDir, { recursive: true });

    const kind = task.pending_feedback ? 'resume' : 'normal';
    const run = store.insertRun(task.id, kind);
    const logPath = join(runsDir, `run-${run.id}.jsonl`);
    writeFileSync(logPath, `# task=${task.id} kind=${kind} agent=${project.agent_id} project=${project.name}\n`);
    store.updateRun(run.id, { status: 'running', started_at: new Date().toISOString(), log_path: logPath });
    store.setTaskStatus(task.id, 'running');
    store.setPendingFeedback(task.id, null); // 反馈已被本次 Run 消费
    events.emit({ kind: 'run.started', task, project });

    const binds = this.getSpawnBinds(project, adapter.homeVolume);
    const env = ['CODEX_HOME=/codex-home', ...this.proxyEnv()];
    const tmo = cfg.scheduler.taskTimeoutMin * 60_000;
    let effectiveImage: string = adapter.image;
    // capability 模式：codex 直接跑宿主——auth/skills/MCP 全部原生（宿主 ~/.codex），
    // 跳过播种/渲染/预装/凭证容器检查（那些是隔离模式的容器环境准备工作）。
    const isCapability = (project.execution ?? 'capability') === 'capability';

    try {
      if (!isCapability) {
        // ══ isolation 模式的容器环境准备 ══
        await this.seedSkills(adapter.homeVolume);
        const mcp = project.mcpServers;
        if (mcp?.length) {
          const registry = (cfg.agents[project.agent_id] as any)?.mcp ?? {};
          const { toml, written, skipped } = renderMcpToml(mcp, registry);
          await writeMcpToVolume(this.deps.docker, adapter.homeVolume, toml);
          if (skipped.length) {
            console.warn(`[mcp] 未在注册表中的 MCP 声明已跳过: ${skipped.join(', ')}（cfg.agents.${project.agent_id}.mcp）`);
          }
          if (written.length) console.log(`🔌 MCP 已注入容器配置: ${written.join(', ')}`);
        }
        const extra = project.extraPackages;
        effectiveImage = extra?.length
          ? await this.installPackages(adapter.image, extra, project.id)
          : adapter.image;
        await this.ensureVolume(adapter.homeVolume);
        const auth = await this.spawn({
          image: adapter.image, cmd: adapter.authCheckArgs(), binds,
          env: [], timeoutMs: 60_000, tag: `auth-${run.id}`,
        });
        if (auth.exitCode !== 0) {
          return this.finish(task, project, run.id, { status: 'blocked', blockedKind: 'auth_missing' },
            { agentMessage: '凭证缺失：请先 agentdesk auth ' + project.agent_id, filesChanged: [], diffStat: '' }, logPath, auth.exitCode);
        }
      } else {
        // ══ capability 模式的宿主环境自检 ══
        // auth：宿主 ~/.codex/auth.json（GUI/CLI 登录态原生共享）
        const authPath = join(process.env.USERPROFILE ?? homedir(), '.codex', 'auth.json');
        if (!existsSync(authPath)) {
          return this.finish(task, project, run.id, { status: 'blocked', blockedKind: 'auth_missing' },
            { agentMessage: '凭证缺失（capability 模式读宿主 ~/.codex/auth.json）：请先完成 codex 登录', filesChanged: [], diffStat: '' }, logPath, undefined);
        }
        // codex CLI 在宿主 PATH 可用性：真正执行时由 runNative 的 spawn error 路径兜底报告
      }

      // ② checkpoint：宿主侧执行（继承用户 LFS/filemode 配置，容器不再触碰 .git）
      const cp = await hostCheckpoint(project.workspace_path, task.id);
      if (!cp.ok) {
        return this.finish(task, project, run.id, { status: 'blocked', blockedKind: 'unknown_error' },
          { agentMessage: `checkpoint 失败：${cp.error}`, filesChanged: [], diffStat: '' }, logPath, undefined);
      }
      const anchor = cp.anchor;

      // ③ 主执行：resume（带反馈+旧会话）或 normal
      const priorSession = kind === 'resume' ? store.lastSessionOfTask(task.id) : undefined;
      const cmd = kind === 'resume' && priorSession
        ? adapter.buildResumeArgs(priorSession, task.pending_feedback!)
        : adapter.buildArgs(task.prompt);

      let sessionId: string | undefined;
      let lastAgentText = '';
      const isNative = (project.execution ?? 'capability') === 'capability';
      const onLine = (line: string) => {
        appendFileSync(logPath, line + '\n');
        const ev = adapter.parseLine(line);
        if (!ev) return;
        if (ev.type === 'session' && ev.sessionId && !sessionId) sessionId = ev.sessionId;
        if (ev.type === 'agent_message' && ev.text) lastAgentText = ev.text;
      };
      const main = isNative
        ? await this.runNativePath({
            adapterImage: adapter.image, cmd,
            cwd: project.workspace_path, env,
            timeoutMs: tmo, tag: `run-${run.id}`,
            onStdoutLine: onLine,
          })
        : await this.spawn({
            image: effectiveImage, cmd, binds, env, timeoutMs: tmo, tag: `run-${run.id}`,
            onStdoutLine: onLine,
          });
      for (const l of main.err) appendFileSync(logPath, '[stderr] ' + l + '\n');
      if (sessionId) store.updateRun(run.id, { session_id: sessionId });

      // ④ 收尾审计：宿主侧执行（相对 checkpoint 的改动清单）
      const audit = await hostAudit(project.workspace_path, anchor);
      const filesChanged = audit.filesChanged;
      const diffStat = audit.diffStat;

      // ⑤ 终态判定
      const result = classifyRun({
        exitCode: main.exitCode,
        killed: main.killed,
        lastAgentText,
        errTail: main.err.slice(-20).join('\n'),
      });
      const summary: RunSummary = { agentMessage: lastAgentText || undefined, filesChanged, diffStat, sessionId };
      this.finish(task, project, run.id, result, summary, logPath, main.exitCode);
    } catch (e: any) {
      this.finish(task, project, run.id,
        { status: 'failed', blockedKind: 'unknown_error' },
        { agentMessage: `runner 异常: ${e?.message ?? e}`, filesChanged: [], diffStat: '' }, logPath, undefined);
    }
  }

  private finish(
    task: Task, project: Project, runId: number,
    result: ReturnType<typeof classifyRun>, summary: RunSummary, logPath: string, exitCode?: number,
  ): void {
    const { store, events } = this.deps;
    store.updateRun(runId, {
      status: result.status,
      exit_code: exitCode,
      blocked_kind: result.blockedKind,
      summary_json: JSON.stringify(summary),
      ended_at: new Date().toISOString(),
      log_path: logPath,
    });
    // 人工取消过的任务不再被 Run 终态覆盖
    if (store.getTask(task.id)?.status !== 'cancelled') {
      store.setTaskStatus(task.id, taskStatusAfterRun(task, store.getRun(runId)!, result));
    }

    if (result.status === 'succeeded') events.emit({ kind: 'run.succeeded', task, project, summary });
    else if (result.status === 'blocked') {
      // 从协议标记行提取人话问题：###AGENTCTL_BLOCKED### {"question":"..."}
      let question: string | undefined;
      const markerLine = summary.agentMessage?.split('\n').find(l => l.includes(AGENTCTL_MARKER));
      if (markerLine) {
        try {
          const j = JSON.parse(markerLine.slice(markerLine.indexOf(AGENTCTL_MARKER) + AGENTCTL_MARKER.length).trim());
          question = typeof j.question === 'string' ? j.question : typeof j.reason === 'string' ? j.reason : undefined;
        } catch { question = markerLine.slice(0, 300); }
      }
      // 循环熔断：60 分钟内该任务 blocked ≥3 次 → 不再自动接受 resume 循环，
      // 通知升级为"需要人工介入环境"，防止昨晚式 20 连问
      const recentBlocks = store.runsOfTask(task.id)
        .filter(r => r.status === 'blocked' && r.ended_at
          && Date.now() - new Date(r.ended_at).getTime() < 60 * 60 * 1000).length;
      const loopCount = recentBlocks; // 含本次
      if (loopCount >= 3) {
        question = `⏸️ 该任务 1 小时内已阻塞 ${loopCount} 次（环境问题循环）。\n\n最新问题：${question ?? '（见日志）'}\n\n建议：先修复环境（缺工具/缺依赖/MCP 未接入）再 resume；或 resume 时明确授权降级方案。`;
      }
      events.emit({ kind: 'run.blocked', task, project, blockedKind: result.blockedKind!, question });
    } else events.emit({ kind: 'run.failed', task, project, reason: summary.agentMessage ?? 'unknown' });
  }
}
