/**
 * Runner —— 单个 Run 的生命周期管家（M0 探针验证过的全部运维知识都在这）：
 *   host-dir 模式：bind mount 用户真实项目目录 + 任务前 checkpoint commit（安全网）
 *   seccomp=unconfined：codex 的 bwrap 沙箱需要 userns（M0 实测硬要求）
 *   codex-home 卷：凭证 + 会话，跨容器 resume 的命脉
 *   事件流：adapter 解析 → jsonl 落盘 + session id + 末条 agent 消息
 *   收尾：git 改动清单 + diffstat → RunSummary；classifyRun 判终态
 */
import Docker from 'dockerode';
import { Writable, type Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { classifyRun, taskStatusAfterRun, parseResultMarker, readRunSummary, runDetails, repeatedRunFailure } from '@agentdesk/core';
import { availableTaskActions } from './actions.js';
import { getAdapterId } from './util.js';
import { hostCheckpoint, hostAudit, hostGitOperation } from './hostgit.js';
import { MergeBlocked, runMerge } from './merge.js';
import { prepareMcpConfig } from './mcp.js';
import { hostCodexLoginStatus, hostCodexProxyEnv } from './native.js';
import { findNativeAgent, prepareNativeAgent, runtimeConfig } from './agent-runtime.js';
import { nativeExecution, runManagedNative, stoppedNativeGroup } from './managed-native.js';
import { ConnectionWatch } from './connection-watch.js';
import { networkSettings } from './network-settings.js';
import type { Task, Project, Run, RunSummary } from '@agentdesk/core';

export interface RunnerDeps {
  docker: Docker;
  cfg: import('./config.js').AppConfig;
  store: import('./store.js').Store;
  events: import('./notify.js').EventBus;
}

interface SpawnResult { exitCode: number | null; killed: boolean; out: string[]; err: string[]; execution?: Run['execution']; oomKilled?: boolean }
type RunResult = ReturnType<typeof classifyRun> | { status: 'cancelled'; blockedKind?: undefined; inputRequest?: undefined };

/** Windows 绝对路径 → docker bind 格式（正斜杠） */
function toBind(path: string): string {
  return path.replace(/\\/g, '/');
}

function lineSink(onLine: (l: string) => void): Writable {
  let buf = '';
  const decoder = new StringDecoder('utf8');
  return new Writable({
    write(chunk, _enc, cb) {
      buf += decoder.write(chunk);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r+$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim()) onLine(line);
      }
      cb();
    },
    final(cb) { buf += decoder.end(); if (buf.trim()) onLine(buf); cb(); },
  });
}

export class Runner {
  private stopping = new Map<number, Promise<void>>();

  constructor(private deps: RunnerDeps) {}

  private projectForTask(task: Task): Project {
    const project = this.deps.store.getProject(task.project_id)!;
    return { ...project, agent_id: task.agent_id ?? 'codex', model: task.model, reasoning_effort: task.reasoning_effort,
      execution: task.execution ?? project.execution ?? 'capability' };
  }

  private getSpawnBinds(project: Project, agentHomeVolume: string): string[] {
    return [
      `${toBind(project.workspace_path)}:/workspace`,
      ...(existsSync(join(project.workspace_path, '.git'))
        ? [`${toBind(join(project.workspace_path, '.git'))}:/workspace/.git:ro`] : []),
      `${agentHomeVolume}:/codex-home`,
    ];
  }

  /** 一次性容器执行命令（与生产语义一致：超时杀、用完删） */
  private async spawn(opts: {
    image: string; cmd: string[]; binds: string[]; env: string[];
    timeoutMs: number; tag: string; onStdoutLine?: (l: string) => void; onStderrLine?: (l: string) => void;
    onContainer?: (id: string) => void;
    beforeStart?: (id: string) => boolean;
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
    let killed = false;
    let stream: Readable | undefined;
    let timer: NodeJS.Timeout | undefined;
    let logTimer: NodeJS.Timeout | undefined;
    try {
      if (opts.beforeStart && !opts.beforeStart(container.id)) {
        return { exitCode: null, killed, out, err, execution: this.cancelledExecution() };
      }
      await container.start();
      opts.onContainer?.(container.id);
      timer = setTimeout(() => { killed = true; void container.kill().catch(() => {}); }, opts.timeoutMs);
      stream = await container.logs({ follow: true, stdout: true, stderr: true }) as Readable;
      const stdout = lineSink(l => { out.push(l); opts.onStdoutLine?.(l); });
      const stderr = lineSink(l => { err.push(l); opts.onStderrLine?.(l); });
      const drained = finished(stream, { cleanup: true }).catch(error => {
        err.push(`读取容器日志异常：${(error as Error).message}`);
      });
      docker.modem.demuxStream(stream, stdout, stderr);
      const wait = await container.wait();
      const stoppedAt = new Date().toISOString();
      clearTimeout(timer);
      logTimer = setTimeout(() => stream?.destroy(), 1000);
      await drained;
      stdout.end();
      stderr.end();
      const oomKilled = opts.beforeStart && wait.StatusCode === 137 ? (await container.inspect()).State.OOMKilled : false;
      return { exitCode: wait.StatusCode ?? null, killed, out, err,
        execution: { stoppedAt, exitCode: wait.StatusCode ?? null, timedOut: killed }, oomKilled };
    } finally {
      clearTimeout(timer);
      clearTimeout(logTimer);
      stream?.destroy();
      // Execution containers retain Docker's exit evidence until the Run is settled.
      if (!opts.beforeStart) await container.remove({ force: true }).catch(() => {});
    }
  }

  private proxyEnv(): string[] {
    const { proxy } = this.deps.cfg;
    const https = proxy.httpsProxy;
    const http = proxy.httpProxy;
    const env: string[] = [];
    if (https) env.push(`HTTPS_PROXY=${https}`, `https_proxy=${https}`);
    if (http) env.push(`HTTP_PROXY=${http}`, `http_proxy=${http}`);
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
   * extraPackages 声明的系统包 → 装完 commit 为以基础镜像和包集合寻址的镜像。
   * 镜像按内容键复用：同名包集合同一镜像，不随 run 数膨胀。
   */
  private async installPackages(baseImage: string, packages: string[]): Promise<string> {
    const { docker } = this.deps;
    if (packages.some(name => typeof name !== 'string' || !/^[a-z0-9][a-z0-9+.-]*(?::[a-z0-9-]+)?(?:=[\w.+:~-]+)?$/.test(name))) {
      throw new Error('extraPackages 必须是有效的 Debian 包名，可以包含架构和版本');
    }
    const base = await docker.getImage(baseImage).inspect();
    const sorted = [...new Set(packages)].sort();
    const key = createHash('sha256').update(JSON.stringify([base.Id, sorted])).digest('hex');
    const target = `agentdesk/runner-with-deps:${key}`;
    try { await docker.getImage(target).inspect(); return target; } catch { /* 不存在，开始构建 */ }
    const c = await docker.createContainer({
      Image: base.Id,
      Cmd: ['sh', '-c', 'apt-get update -qq && apt-get install -y -qq --no-install-recommends "$@" && rm -rf /var/lib/apt/lists/*',
        'agentdesk', ...sorted],
      Labels: { 'agentdesk.extra': 'pkgs', 'agentdesk.packages': key },
    });
    try {
      await c.start();
      const wait = await c.wait();
      if (wait.StatusCode !== 0) throw new Error(`依赖预装失败（exit=${wait.StatusCode}）: ${sorted.join(',')}`);
      await c.commit({ repo: 'agentdesk/runner-with-deps', tag: key });
    } finally {
      await c.remove({ force: true }).catch(() => {});
    }
    console.log(`📦 项目依赖镜像就绪: ${target} (${packages.join(', ')})`);
    return target;
  }
  /** Native 路径：codex 直接跑宿主（无容器）。与 Docker 路径产出同构的 SpawnResult */
  private async runNativePath(opts: {
    adapterImage: string; cmd: string[]; cwd: string; env: string[];
    timeoutMs: number; tag: string; onStdoutLine?: (l: string) => void; onStderrLine?: (l: string) => void;
    control: string;
    onPid: (pid: number) => void;
  }): Promise<SpawnResult> {
    const main = await runManagedNative({
      cmd: opts.cmd, cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs,
      onStdoutLine: opts.onStdoutLine,
      onStderrLine: opts.onStderrLine,
    }, opts.control, opts.onPid);
    const execution = nativeExecution(opts.control);
    if (!execution && existsSync(opts.control + '.active')) throw new Error('宿主进程树停止结果无法核实');
    return {
      ...main, exitCode: execution?.exitCode ?? null, killed: !!execution?.timedOut,
      execution: execution ?? { stoppedAt: new Date().toISOString(), exitCode: null, error: main.err.at(-1) },
    };
  }

  private cancelledExecution(): NonNullable<Run['execution']> {
    return { stoppedAt: new Date().toISOString(), exitCode: null, cancelled: true };
  }

  private updateCancellation(runId: number, patch: Partial<NonNullable<Run['cancellation']>>): void {
    const current = this.deps.store.getRun(runId);
    if (current?.cancellation && (current.status === 'starting' || current.status === 'running')) {
      const cancellation = { ...current.cancellation, ...patch };
      if (cancellation.issue !== current.cancellation.issue || cancellation.killSent !== current.cancellation.killSent) {
        this.deps.store.updateRun(runId, { cancellation });
      }
    }
  }

  /** Recovery never signals a persisted PID. */
  requestStop(run: Run): Promise<void> {
    if (!run.cancellation || run.execution) return Promise.resolve();
    const pending = this.stopping.get(run.id);
    if (pending) return pending;
    const stop = this.stopWorker(run).catch(error => {
      this.updateCancellation(run.id, { issue: `无法确认停止：${(error as Error).message}` });
    }).finally(() => this.stopping.delete(run.id));
    this.stopping.set(run.id, stop);
    return stop;
  }

  private async stopWorker(run: Run): Promise<void> {
    const worker = run.worker;
    if (!worker) {
      this.updateCancellation(run.id, { issue: '等待当前准备步骤退出。' });
      return;
    }
    if (worker.kind === 'native') {
      if (!worker.control) {
        this.updateCancellation(run.id, { issue: '此 Run 缺少可验证的进程树控制记录，正在等待执行器退出。' });
        return;
      }
      const request = worker.control + '.cancel';
      if (!existsSync(request)) writeFileSync(request, '', { mode: 0o600 });
      this.updateCancellation(run.id, { issue: nativeExecution(worker.control) ? undefined : '等待确认宿主进程树全部退出。' });
      return;
    }
    if (run.status !== 'running' || run.cancellation?.killSent) return;
    const container = this.deps.docker.getContainer(worker.id);
    this.updateCancellation(run.id, { issue: '正在向 Docker 核实容器状态。' });
    const state = await container.inspect({ abortSignal: AbortSignal.timeout(3000) }).then(info => info.State, error => {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    });
    if (!(state?.Running || state?.Restarting)) return;
    try {
      await container.kill({ signal: 'SIGKILL', abortSignal: AbortSignal.timeout(3000) });
      this.updateCancellation(run.id, { killSent: true, issue: '等待容器确认退出。' });
    } catch (error) {
      if (![304, 404, 409].includes((error as { statusCode?: number }).statusCode ?? 0)) throw error;
      this.updateCancellation(run.id, { issue: '等待 Docker 确认容器的最终状态。' });
    }
  }

  async workerIsAlive(worker: Run['worker']): Promise<boolean> {
    if (!worker) return false;
    if (worker.kind === 'native') {
      try { process.kill(worker.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    }
    try {
      const info = await this.deps.docker.getContainer(worker.id).inspect();
      return info.State.Running || info.State.Restarting;
    } catch (error) {
      return (error as { statusCode?: number }).statusCode !== 404;
    }
  }

  async recoverRun(run: Run): Promise<boolean> {
    const { store, docker } = this.deps;
    if (run.status !== 'starting' && run.status !== 'running') return true;
    let execution = run.execution;
    const worker = run.worker;
    if (!execution && worker?.kind === 'native' && worker.control) {
      if (run.cancellation) await this.requestStop(run);
      execution = nativeExecution(worker.control);
      const active = existsSync(worker.control + '.active');
      if (!execution && !active && worker.pid === 0 && existsSync(worker.control + '.cancel')) {
        execution = this.cancelledExecution();
      }
      const supervisorAlive = !execution && worker.pid > 0 && await this.workerIsAlive(worker);
      if (!execution && (active || supervisorAlive)) {
        if (!supervisorAlive && worker.pid > 0) {
          try {
            if (await stoppedNativeGroup(worker.control, this.deps.cfg.dataDir)) {
              execution = nativeExecution(worker.control);
              if (!execution && !run.cancellation) { store.interruptRun(run); return true; }
              execution ??= { ...this.cancelledExecution(), error: 'daemon 中断后确认了原进程树已退出。' };
            } else {
              this.updateCancellation(run.id, { issue: '进程监管器已退出，正在核对受管进程树。' });
            }
          } catch (error) {
            this.updateCancellation(run.id, { issue: `无法核实受管进程树：${(error as Error).message}` });
          }
        }
        if (!execution) return false;
      }
    } else if (!execution && worker?.kind === 'docker') {
      const container = docker.getContainer(worker.id);
      let state;
      try { state = (await container.inspect({ abortSignal: AbortSignal.timeout(3000) })).State; }
      catch (error) {
        if ((error as { statusCode?: number }).statusCode !== 404) {
          this.updateCancellation(run.id, { issue: `无法向 Docker 核实容器状态：${(error as Error).message}` });
          return false;
        }
      }
      if (state?.Running || state?.Restarting || state?.Paused) {
        if (run.cancellation) await this.requestStop({ ...run, status: 'running' });
        return false;
      }
      if (state?.Status === 'created') {
        try { await container.remove({ abortSignal: AbortSignal.timeout(3000) }); }
        catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 404) {
            this.updateCancellation(run.id, { issue: 'Docker 正在核对容器的启动与取消顺序。' });
            return false;
          }
        }
        execution = run.cancellation ? this.cancelledExecution()
          : { stoppedAt: new Date().toISOString(), exitCode: null, error: 'Docker 容器尚未启动。' };
      } else if (state?.Status === 'exited' || state?.Status === 'dead') {
        const cancelled = !!run.cancellation?.killSent && state.ExitCode === 137 && !state.OOMKilled;
        execution = { exitCode: state.ExitCode, stoppedAt: state.FinishedAt, cancelled };
      } else if (state) {
        this.updateCancellation(run.id, { issue: `Docker 返回了尚无法确认停止的状态：${state.Status}。` });
        return false;
      }
    } else if (!execution && await this.workerIsAlive(worker)) {
      if (run.cancellation) await this.requestStop(run);
      return false;
    }
    if (!execution && !worker && run.cancellation) execution = this.cancelledExecution();
    if (!execution) { store.interruptRun(run); return true; }

    const task = store.getTask(run.task_id)!;
    const project = this.projectForTask(task);
    const summary: RunSummary = readRunSummary(run) ?? {
      diagnostic: execution.error ?? 'daemon 重启后核对了执行器的退出结果。', filesChanged: [], diffStat: '',
    };
    const record = (line: string) => {
      if (!run.log_path) return;
      try { appendFileSync(run.log_path, line); }
      catch (error) { console.error('无法写入 Run 恢复日志', error); }
    };
    let result: RunResult;
    if (execution.cancelled) result = { status: 'cancelled' };
    else if (run.blocked_kind && run.blocked_kind !== 'unknown_error') result = { status: 'blocked', blockedKind: run.blocked_kind };
    else result = classifyRun({
      exitCode: execution.exitCode, killed: !!execution.timedOut, lastAgentText: summary.agentMessage ?? '',
      inputRequest: summary.inputRequest, errTail: execution.error ?? '',
    });
    await this.audit(project, run.checkpoint_sha ?? '', summary, record);
    this.finish(task, project, run.id, result, summary, run.log_path ?? undefined, execution);
    if (worker?.kind === 'docker') await docker.getContainer(worker.id).remove().catch(() => {});
    return true;
  }

  async execute(taskId: number): Promise<void> {
    const { store, events } = this.deps;
    const cfg = runtimeConfig(this.deps.cfg, store);
    const task = store.getTask(taskId)!;
    const project = this.projectForTask(task);
    const run = store.beginRun(task.id);
    if (!run) return;
    const kind = run.kind;
    const runsDir = join(cfg.logDir, 'runs');
    store.updateRun(run.id, { started_at: new Date().toISOString() });
    // 独立数据库可能共用日志目录，run ID 只在当前数据库内唯一。
    const logPath = join(runsDir, `run-${run.id}-${randomUUID()}.jsonl`);
    try {
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(logPath, `# task=${task.id} kind=${kind} agent=${project.agent_id} project=${project.name}\n`,
        { flag: 'wx', mode: 0o600 });
    } catch (error) {
      return this.finish(task, project, run.id, { status: 'failed', blockedKind: 'unknown_error' },
        { diagnostic: `无法创建任务日志 ${logPath}：${(error as Error).message}`, filesChanged: [], diffStat: '' });
    }
    store.updateRun(run.id, { log_path: logPath });
    if ((project.execution ?? 'capability') === 'capability') {
      const network = networkSettings(cfg, store);
      store.updateRun(run.id, { network: { httpsProxy: network.httpsProxy, httpProxy: network.httpProxy } });
    }
    events.emit({ kind: 'run.started', runId: run.id, task, project });

    let logWriteFailed = false;
    const record = (message: string) => {
      if (logWriteFailed) return;
      try { appendFileSync(logPath, message); }
      catch (error) {
        logWriteFailed = true;
        console.error(`无法写入任务日志 ${logPath}`, error);
      }
    };
    const stopBeforeExecution = () => {
      if (!store.getRun(run.id)?.cancellation) return false;
      this.finish(task, project, run.id, { status: 'cancelled' },
        { diagnostic: '已在启动 Agent 前停止。', filesChanged: [], diffStat: '' }, logPath, this.cancelledExecution());
      return true;
    };
    const merge = store.getMerge(task.id);
    if (merge) {
      try {
        if (project.execution === 'isolation') throw new MergeBlocked('自动化合并需要 capability 项目');
        store.updateRun(run.id, { status: 'running' });
        const result = await runMerge({
          cwd: project.workspace_path,
          worktree: resolve(cfg.dataDir, 'merge-worktrees', String(task.id)),
          plan: merge.plan, state: merge.state,
          save: state => store.saveMerge(task.id, state),
          log: record, testTimeout: cfg.scheduler.taskTimeoutMin * 60_000,
          onTestPid: pid => store.updateRun(run.id, { worker: { kind: 'native', pid } }),
        });
        record(result.message + '\n');
        const summary = { agentMessage: result.message, filesChanged: [], diffStat: '' };
        if (result.status === 'waiting') {
          store.deferMerge(task.id, Date.now() + 30_000);
          store.finishRun(run.id, { status: 'succeeded', summary_json: JSON.stringify(summary), ended_at: new Date().toISOString() }, 'queued');
        } else {
          this.finish(task, project, run.id, { status: 'succeeded' }, summary, logPath, 0);
        }
      } catch (error) {
        const message = (error as Error).message;
        record(message + '\n');
        const result = error instanceof MergeBlocked ? { status: 'blocked', blockedKind: 'approval_needed' } as const
          : { status: 'failed', blockedKind: 'unknown_error' } as const;
        this.finish(task, project, run.id, result, { agentMessage: message, filesChanged: [], diffStat: '' }, logPath);
      }
      return;
    }

    const adapter = getAdapterId(project.agent_id, cfg);
    const agentCfg = cfg.agents[project.agent_id]!;
    const binds = this.getSpawnBinds(project, adapter.homeVolume);
    const env = ['CODEX_HOME=/codex-home', ...this.proxyEnv()];
    const tmo = cfg.scheduler.taskTimeoutMin * 60_000;
    let effectiveImage: string = adapter.image;
    // capability 模式：codex 直接跑宿主——auth/skills/MCP 全部原生（宿主 ~/.codex），
    // 跳过播种/渲染/预装/凭证容器检查（那些是隔离模式的容器环境准备工作）。
    const executionMode = project.execution ?? 'capability';
    const isCapability = executionMode === 'capability';
    let cleanupConfig: (() => void) | undefined;
    let cleanupAgent: (() => void) | undefined;
    let connectionTimer: ReturnType<typeof setInterval> | undefined;

    try {
      if (!isCapability) {
        if (project.agent_id !== 'codex') throw new Error(`${project.agent_id} 当前仅支持能力优先模式，请使用 capability。`);
        // ══ isolation 模式的容器环境准备 ══
        await this.seedSkills(adapter.homeVolume);
        await this.ensureVolume(adapter.homeVolume);
        const mcp = project.mcpServers;
        if (mcp?.length) {
          const { path, written, skipped, cleanup } = await prepareMcpConfig(
            this.deps.docker, adapter.homeVolume, mcp, agentCfg.mcp ?? {},
          );
          cleanupConfig = cleanup;
          binds.push(`${toBind(path)}:/codex-home/config.toml:ro`);
          if (skipped.length) {
            console.warn(`[mcp] 未在注册表中的 MCP 声明已跳过: ${skipped.join(', ')}（cfg.agents.${project.agent_id}.mcp）`);
          }
          if (written.length) console.log(`🔌 MCP 已注入容器配置: ${written.join(', ')}`);
        }
        const extra = project.extraPackages;
        effectiveImage = extra?.length
          ? await this.installPackages(adapter.image, extra)
          : adapter.image;
        const auth = await this.spawn({
          image: adapter.image, cmd: adapter.authCheckArgs(), binds,
          env: [], timeoutMs: 60_000, tag: `auth-${run.id}`,
        });
        if (auth.exitCode !== 0) {
          if (stopBeforeExecution()) return;
          return this.finish(task, project, run.id, { status: 'blocked', blockedKind: auth.killed ? 'timeout' : 'auth_missing' },
            { diagnostic: auth.killed ? '隔离执行器的认证检查超时。' : '凭证缺失，请先运行 desk auth。', filesChanged: [], diffStat: '' }, logPath);
        }
      } else {
        // ══ capability 模式的宿主环境自检 ══
        // codex CLI：发现宿主可用版本（PATH 优先 → GUI 私有运行时最新版）
        const native = findNativeAgent(project.agent_id, cfg);
        if (!native) {
          return this.finish(task, project, run.id, { status: 'failed', blockedKind: 'unknown_error' },
            { diagnostic: `宿主上未发现 ${project.agent_id} CLI。请安装对应客户端或配置 agents.${project.agent_id}.executable。`, filesChanged: [], diffStat: '' }, logPath);
        }
        const status = project.agent_id === 'codex' ? await hostCodexLoginStatus(native.command[0]!, cfg.proxy) : undefined;
        if (status && status.exitCode !== 0) {
          if (stopBeforeExecution()) return;
          return this.finish(task, project, run.id, { status: 'blocked', blockedKind: status.killed ? 'timeout' : 'auth_missing' },
            { diagnostic: status.killed ? '宿主 Codex 认证检查超时。' : '宿主 Codex 无法确认登录。请用当前运行账号执行 desk auth。', filesChanged: [], diffStat: '' }, logPath);
        }
      }

      // ② checkpoint：宿主侧执行（继承用户 LFS/filemode 配置，容器不再触碰 .git）
      if (stopBeforeExecution()) return;
      const cp = await hostCheckpoint(project.workspace_path, task.id);
      if (stopBeforeExecution()) return;
      const continuingGit = !!cp.gitOperation && isCapability && kind === 'resume';
      if (!cp.ok && !continuingGit) {
        return this.finish(task, project, run.id, { status: 'blocked', blockedKind: cp.gitOperation ? 'git_in_progress' : 'unknown_error' },
          { diagnostic: `checkpoint 失败：${cp.error}`, blocker: cp.error, filesChanged: [], diffStat: '' }, logPath);
      }
      const anchor = cp.ok ? cp.anchor : '';
      if (continuingGit) {
        record(`# 用户请求续跑：Git 操作进行中（${cp.gitOperation}），本轮没有可用的快照基线\n`);
      } else if (anchor && anchor !== 'NO-GIT') {
        store.updateRun(run.id, { checkpoint_sha: anchor });
        record(`# checkpoint=${anchor}\n`);
      }

      // ③ 主执行：resume（带反馈+旧会话）或 normal
      const feedback = task.pending_feedback;
      const priorSession = feedback ? store.lastSessionOfTask(task.id) : undefined;
      let responseSchemaPath: string | undefined;
      if (adapter.finalResponseSchema) {
        const directory = join(cfg.dataDir, 'schemas');
        mkdirSync(directory, { recursive: true });
        const hostPath = resolve(directory, `${adapter.id}-final-response.json`);
        const schema = JSON.stringify(adapter.finalResponseSchema);
        if (!existsSync(hostPath) || readFileSync(hostPath, 'utf8') !== schema) {
          writeFileSync(hostPath, schema, { mode: 0o600 });
        }
        responseSchemaPath = isCapability ? hostPath : '/agentdesk-final-response.json';
        if (!isCapability) binds.push(`${toBind(hostPath)}:${responseSchemaPath}:ro`);
      }
      const cmd = priorSession && feedback
        ? adapter.buildResumeArgs(priorSession, feedback, executionMode, responseSchemaPath, project.model || undefined, project.reasoning_effort || undefined)
        : adapter.buildArgs(feedback ? `${task.prompt}\n\n${feedback}` : task.prompt, executionMode, responseSchemaPath, project.model || undefined, project.reasoning_effort || undefined);

      let sessionId: string | undefined;
      let lastAgentText = '';
      let lastAgentError = '';
      let lastAgentModel: string | undefined;
      let inputRequest: string | undefined;
      let replyInputRequest: string | undefined;
      let warnedActivityWrite = false;
      const isNative = isCapability; // capability = 宿主原生执行
      // native 模式不透传容器 env（CODEX_HOME=/codex-home 是容器内路径，宿主不存在）
      const nativeEnv = hostCodexProxyEnv(cfg.proxy);
      const native = isNative ? prepareNativeAgent({ id: project.agent_id, cmd, model: project.model, reasoningEffort: project.reasoning_effort, cwd: project.workspace_path, runId: run.id, cfg }) : undefined;
      if (native) { cleanupAgent = native.cleanup; nativeEnv.push(...native.env); }
      const control = logPath + '.control';
      const watch = new ConnectionWatch({
        changed: connection => store.updateRun(run.id, { connection }),
        notify: (kind, connection) => {
          const current = store.getRun(run.id);
          if (current && ['starting', 'running'].includes(current.status) && !current.cancellation) events.emit({ kind, connection, runId: run.id, task, project,
            details: runDetails(current, project.agent_id) });
        },
      });
      const streamedErrors = new Set<string>();
      connectionTimer = setInterval(() => {
        const current = store.getRun(run.id);
        if (current && ['starting', 'running'].includes(current.status) && !current.cancellation) watch.tick();
      }, 1000);
      const onLine = (line: string) => {
        record(line + '\n');
        const ev = adapter.parseLine(line, !!responseSchemaPath);
        if (!ev) return;
        if (ev.type === 'error' && ev.text) watch.error(ev.text);
        if (ev.progress || ev.type === 'agent_message' && ev.text || ev.activity && (ev.activity.kind !== 'turn' || ev.activity.phase === 'completed')) watch.progress();
        if (ev.activity) {
          try { store.recordRunActivity(run.id, { ...ev.activity, at: new Date().toISOString() }); }
          catch (error) {
            if (!warnedActivityWrite) console.warn(`Run #${run.id} 记录活动失败:`, (error as Error).message);
            warnedActivityWrite = true;
          }
        }
        if (ev.model) lastAgentModel = ev.model;
        if (ev.sessionId && !sessionId) {
          sessionId = ev.sessionId;
          store.updateRun(run.id, { session_id: sessionId });
        }
        if (ev.type === 'agent_message' && ev.text !== undefined) {
          lastAgentText = ev.text;
          replyInputRequest = ev.inputRequest;
        }
        if (ev.type === 'error' && ev.text) lastAgentError = ev.text;
        if (ev.type === 'input_requested' && ev.text?.trim()) inputRequest = ev.text;
      };
      const onStderrLine = (line: string) => {
        streamedErrors.add(line);
        record('[stderr] ' + line + '\n');
        watch.stderr(line);
      };
      if (isNative) store.updateRun(run.id, { worker: { kind: 'native', pid: 0, control } });
      const main = isNative
        ? await this.runNativePath({
            adapterImage: adapter.image, cmd: native!.cmd,
            cwd: project.workspace_path, env: nativeEnv,
            timeoutMs: tmo, tag: `run-${run.id}`,
            control,
            onStdoutLine: onLine,
            onStderrLine,
            onPid: pid => store.updateRun(run.id, { status: 'running', worker: { kind: 'native', pid, control } }),
          })
        : await this.spawn({
            image: effectiveImage, cmd, binds, env, timeoutMs: tmo, tag: `run-${run.id}`,
            onStdoutLine: onLine,
            onStderrLine,
            beforeStart: id => {
              store.updateRun(run.id, { worker: { kind: 'docker', id } });
              return !store.getRun(run.id)?.cancellation;
            },
            onContainer: id => store.updateRun(run.id, { status: 'running', worker: { kind: 'docker', id } }),
          });
      clearInterval(connectionTimer);
      for (const line of main.err) if (!streamedErrors.has(line)) record('[stderr] ' + line + '\n');

      // ④ 收尾：记录运行结果与工作区观察。
      const execution = main.execution!;
      // Record the exit before awaiting container stop receipts or auditing the workspace.
      store.updateRun(run.id, { execution });
      await this.stopping.get(run.id);
      if (!isNative && !main.oomKilled && !execution.timedOut && execution.exitCode === 137
        && store.getRun(run.id)?.cancellation?.killSent) {
        execution.cancelled = true;
      }
      const result: RunResult = execution.cancelled ? { status: 'cancelled' } : classifyRun({
        exitCode: main.exitCode,
        killed: main.killed,
        interrupted: main.exitCode === null && !!store.getRun(run.id)?.worker,
        lastAgentText,
        inputRequest: inputRequest ?? replyInputRequest,
        errTail: [...main.err.slice(-20), lastAgentError].join('\n'),
        primaryError: lastAgentError || undefined,
      });
      // 旧会话仍可能报告部分完成，保留未完成项供续跑。
      const report = parseResultMarker(lastAgentText);
      const summary: RunSummary = {
        agentId: project.agent_id, model: lastAgentModel ?? project.model ?? undefined,
        agentMessage: lastAgentText || report?.summary,
        filesChanged: [], diffStat: '', sessionId,
        partial: report ? !report.done : undefined,
        remaining: report?.remaining,
        inputRequest: result.inputRequest,
      };
      if (execution.error || (main.exitCode === null && result.status === 'failed')) {
        summary.diagnostic = execution.error ?? main.err.at(-1);
      } else if (lastAgentError && main.exitCode !== 0) {
        summary.diagnostic = lastAgentError;
      }
      store.updateRun(run.id, { execution, blocked_kind: result.blockedKind, summary_json: JSON.stringify(summary) });
      await this.audit(project, anchor, summary, record);
      this.finish(task, project, run.id, result, summary, logPath, execution);
      const worker = store.getRun(run.id)?.worker;
      if (worker?.kind === 'docker') await this.deps.docker.getContainer(worker.id).remove().catch(() => {});
    } catch (e: any) {
      record(`# 执行器异常：${e?.message ?? e}\n`);
      const current = store.getRun(run.id);
      if (current?.worker || current?.execution) {
        this.updateCancellation(run.id, { issue: e?.message ?? String(e) });
        throw e;
      }
      if (stopBeforeExecution()) return;
      this.finish(task, project, run.id,
        { status: 'failed', blockedKind: 'unknown_error' },
        { diagnostic: `执行器异常：${e?.message ?? e}`, filesChanged: [], diffStat: '' }, logPath);
    } finally {
      clearInterval(connectionTimer);
      cleanupConfig?.();
      cleanupAgent?.();
    }
  }

  private async audit(project: Project, anchor: string, summary: RunSummary, record: (line: string) => void): Promise<void> {
    try {
      const pendingGit = await hostGitOperation(project.workspace_path);
      if (pendingGit) {
        summary.blocker = `工作目录还有未结束的 Git 操作（${pendingGit}）。`;
        record(`# ${summary.blocker}\n`);
      }
      Object.assign(summary, await hostAudit(project.workspace_path, pendingGit ? '' : anchor));
    } catch (error) {
      const message = `工作区审计失败：${(error as Error).message}`;
      record(`# ${message}\n`);
      summary.diagnostic = [summary.diagnostic, message].filter(Boolean).join('\n');
    }
  }

  private finish(
    task: Task, project: Project, runId: number,
    result: RunResult, summary: RunSummary, logPath?: string, execution?: Run['execution'] | number,
  ): void {
    const { store, events } = this.deps;
    const retryViaCli = !!store.getMerge(task.id);
    summary.agentId = project.agent_id;
    store.finishRun(runId, {
      status: result.status,
      exit_code: typeof execution === 'number' ? execution : execution?.exitCode ?? undefined,
      execution: typeof execution === 'object' ? execution : undefined,
      blocked_kind: result.blockedKind,
      summary_json: JSON.stringify(summary),
      ended_at: new Date().toISOString(),
      log_path: logPath,
    }, result.status === 'cancelled' ? 'cancelled' : taskStatusAfterRun(result),
    result.status === 'succeeded' && summary.partial ? summary.remaining ?? null : null);

    const saved = store.getTask(task.id) ?? task;
    const event = { runId, task: saved, project, details: runDetails(store.getRun(runId)!, project.agent_id, saved.partial_remaining),
      repeatedFailure: repeatedRunFailure(store.runsOfTask(task.id)),
      actions: availableTaskActions(store, saved, 'dingtalk') };
    if (result.status === 'cancelled') {
      if (logPath) {
        try { appendFileSync(logPath, `# Run #${runId} 已取消 · ${event.details.stoppedAt}\n`); }
        catch (error) { console.error('无法写入 Run 停止日志', error); }
      }
      events.emit({ ...event, kind: 'run.cancelled', summary });
    }
    else if (result.status === 'succeeded') events.emit({ ...event, kind: 'run.succeeded', summary });
    else if (result.status === 'blocked') events.emit({
      ...event, kind: 'run.blocked', blockedKind: result.blockedKind!, summary, retryViaCli,
    });
    else events.emit({ ...event, kind: 'run.failed', reason: summary.diagnostic ?? summary.agentMessage ?? '执行异常', retryViaCli });
  }
}
