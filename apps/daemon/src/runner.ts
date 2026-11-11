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
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { classifyRun, taskStatusAfterRun } from '@agentdesk/core';
import { getAdapterId } from './util.js';
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

  /** 任务入口：task 必须处于 queued，终态落库 + 发通知 */
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

    try {
      // ① 凭证自检：auth.json 不在就别浪费一次 codex 启动
      await this.ensureVolume(adapter.homeVolume);
      const auth = await this.spawn({
        image: adapter.image, cmd: adapter.authCheckArgs(), binds,
        env: [], timeoutMs: 60_000, tag: `auth-${run.id}`,
      });
      if (auth.exitCode !== 0) {
        return this.finish(task, project, run.id, { status: 'blocked', blockedKind: 'auth_missing' },
          { agentMessage: '凭证缺失：请先 agentdesk auth ' + project.agent_id, filesChanged: [], diffStat: '' }, logPath);
      }

      // ② checkpoint：把当前工作树（含用户未提交 WIP）钉成回滚锚点
      const checkpoint = await this.spawn({
        image: adapter.image,
        cmd: ['/bin/sh', '-c',
          'git rev-parse HEAD 2>/dev/null || echo NO-GIT; ' +
          'git -c user.name=agentdesk -c user.email=agentdesk@local -c core.filemode=false add -A 2>/dev/null; ' +
          'git -c user.name=agentdesk -c user.email=agentdesk@local -c core.filemode=false commit -qm "agentdesk: pre-task checkpoint (task-' + task.id + ')" 2>/dev/null; ' +
          'git rev-parse HEAD'],
        binds, env: [], timeoutMs: 120_000, tag: `ckpt-${run.id}`,
      });
      const anchor = checkpoint.out.at(-1)?.trim() ?? '';
      const hasGit = anchor !== 'NO-GIT' && /^[0-9a-f]{7,40}$/.test(anchor);

      // ③ 主执行：resume（带反馈+旧会话）或 normal
      const priorSession = kind === 'resume' ? store.lastSessionOfTask(task.id) : undefined;
      const cmd = kind === 'resume' && priorSession
        ? adapter.buildResumeArgs(priorSession, task.pending_feedback!)
        : adapter.buildArgs(task.prompt);

      let sessionId: string | undefined;
      let lastAgentText = '';
      const main = await this.spawn({
        image: adapter.image, cmd, binds, env, timeoutMs: tmo, tag: `run-${run.id}`,
        onStdoutLine: (line) => {
          appendFileSync(logPath, line + '\n');
          const ev = adapter.parseLine(line);
          if (!ev) return;
          if (ev.type === 'session' && ev.sessionId && !sessionId) sessionId = ev.sessionId;
          if (ev.type === 'agent_message' && ev.text) lastAgentText = ev.text;
        },
      });
      for (const l of main.err) appendFileSync(logPath, '[stderr] ' + l + '\n');
      if (sessionId) store.updateRun(run.id, { session_id: sessionId });

      // ④ 收尾审计：本任务改了哪些文件（相对 checkpoint）
      let filesChanged: string[] = [];
      let diffStat = '';
      if (hasGit) {
        const post = await this.spawn({
          image: adapter.image,
          cmd: ['/bin/sh', '-c',
            `echo '---PORCELAIN---'; git -c core.filemode=false status --porcelain; ` +
            `echo '---DIFFSTAT---'; git -c core.filemode=false diff --stat ${anchor}..HEAD | tail -5`],
          binds, env: [], timeoutMs: 60_000, tag: `post-${run.id}`,
        });
        const text = post.out.join('\n');
        const p = text.indexOf('---PORCELAIN---');
        const d = text.indexOf('---DIFFSTAT---');
        if (p >= 0 && d > p) {
          filesChanged = text.slice(p + 15, d).split('\n').map(s => s.trim()).filter(Boolean);
          diffStat = text.slice(d + 14).trim();
        }
      }

      // ⑤ 终态判定
      const result = classifyRun({
        exitCode: main.exitCode,
        killed: main.killed,
        lastAgentText,
        errTail: main.err.slice(-20).join('\n'),
      });
      const summary: RunSummary = { agentMessage: lastAgentText || undefined, filesChanged, diffStat, sessionId };
      this.finish(task, project, run.id, result, summary, logPath);
    } catch (e: any) {
      this.finish(task, project, run.id,
        { status: 'failed', blockedKind: 'unknown_error' },
        { agentMessage: `runner 异常: ${e?.message ?? e}`, filesChanged: [], diffStat: '' }, logPath);
    }
  }

  private finish(
    task: Task, project: Project, runId: number,
    result: ReturnType<typeof classifyRun>, summary: RunSummary, logPath: string,
  ): void {
    const { store, events } = this.deps;
    store.updateRun(runId, {
      status: result.status,
      blocked_kind: result.blockedKind,
      summary_json: JSON.stringify(summary),
      ended_at: new Date().toISOString(),
      log_path: logPath,
    });
    const next = taskStatusAfterRun(task, store.getRun(runId)!, result);
    store.setTaskStatus(task.id, next);

    if (result.status === 'succeeded') events.emit({ kind: 'run.succeeded', task, project, summary });
    else if (result.status === 'blocked') {
      const question = summary.agentMessage?.split('\n').find(l => l.includes('###AGENTCTL_BLOCKED###'))?.slice(0, 300);
      events.emit({ kind: 'run.blocked', task, project, blockedKind: result.blockedKind!, question });
    } else events.emit({ kind: 'run.failed', task, project, reason: summary.agentMessage ?? 'unknown' });
  }
}
