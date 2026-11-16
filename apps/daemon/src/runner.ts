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
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { classifyRun, taskStatusAfterRun, AGENTCTL_MARKER, parseResultMarker, stripAgentctlLines } from '@agentdesk/core';
import { getAdapterId } from './util.js';
import { hostCheckpoint, hostAudit, hostGitOperation } from './hostgit.js';
import { MergeBlocked, runMerge } from './merge.js';
import { prepareMcpConfig } from './mcp.js';
import { findHostCodex, hostCodexLoginStatus, hostCodexProxyEnv, runNative } from './native.js';
import type { Task, Project, Run, RunSummary } from '@agentdesk/core';

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
      ...(existsSync(join(project.workspace_path, '.git'))
        ? [`${toBind(join(project.workspace_path, '.git'))}:/workspace/.git:ro`] : []),
      `${agentHomeVolume}:/codex-home`,
    ];
  }

  /** 一次性容器执行命令（与生产语义一致：超时杀、用完删） */
  private async spawn(opts: {
    image: string; cmd: string[]; binds: string[]; env: string[];
    timeoutMs: number; tag: string; onStdoutLine?: (l: string) => void;
    onContainer?: (id: string) => void;
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
    opts.onContainer?.(container.id);
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
    timeoutMs: number; tag: string; onStdoutLine?: (l: string) => void;
    onPid: (pid: number) => void;
  }): Promise<{ exitCode: number; killed: boolean; out: string[]; err: string[] }> {
    // 命令映射：容器内 'codex ...' → 宿主实际发现的 codex 可执行路径
    const hostCodex = findHostCodex();
    if (!hostCodex) throw new Error('宿主 codex CLI 未找到（findHostCodex）');
    const cmd = opts.cmd[0] === 'codex' ? [hostCodex, ...opts.cmd.slice(1)] : opts.cmd;
    return runNative({
      cmd, cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs,
      onStdoutLine: opts.onStdoutLine,
    }, child => { if (child.pid) opts.onPid(child.pid); });
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

  async execute(taskId: number): Promise<void> {
    const { cfg, store, events } = this.deps;
    const task = store.getTask(taskId)!;
    const project = store.getProject(task.project_id)!;
    const run = store.beginRun(task.id);
    if (!run) return;
    const kind = run.kind;
    const runsDir = join(cfg.logDir, 'runs');
    // 独立数据库可能共用日志目录，run ID 只在当前数据库内唯一。
    const logPath = join(runsDir, `run-${run.id}-${randomUUID()}.jsonl`);
    try {
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(logPath, `# task=${task.id} kind=${kind} agent=${project.agent_id} project=${project.name}\n`,
        { flag: 'wx', mode: 0o600 });
    } catch (error) {
      return this.finish(task, project, run.id, { status: 'failed', blockedKind: 'unknown_error' },
        { agentMessage: `无法创建任务日志 ${logPath}：${(error as Error).message}`, filesChanged: [], diffStat: '' });
    }
    store.updateRun(run.id, { status: 'running', started_at: new Date().toISOString(), log_path: logPath });
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
    const merge = store.getMerge(task.id);
    if (merge) {
      try {
        if (project.execution === 'isolation') throw new MergeBlocked('自动化合并需要 capability 项目');
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
    const execution = project.execution ?? 'capability';
    const isCapability = execution === 'capability';
    let cleanupConfig: (() => void) | undefined;

    try {
      if (!isCapability) {
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
          return this.finish(task, project, run.id, { status: 'blocked', blockedKind: 'auth_missing' },
            { agentMessage: '凭证缺失：请先 agentdesk auth ' + project.agent_id, filesChanged: [], diffStat: '' }, logPath, auth.exitCode);
        }
      } else {
        // ══ capability 模式的宿主环境自检 ══
        // codex CLI：发现宿主可用版本（PATH 优先 → GUI 私有运行时最新版）
        const hostCodex = findHostCodex();
        if (!hostCodex) {
          return this.finish(task, project, run.id, { status: 'blocked', blockedKind: 'auth_missing' },
            { agentMessage: '宿主上未发现 codex CLI（PATH 无 codex，且未找到 GUI 运行时）。请安装 codex CLI 后重试。', filesChanged: [], diffStat: '' }, logPath, undefined);
        }
        const status = await hostCodexLoginStatus(hostCodex, cfg.proxy);
        if (status.exitCode !== 0) {
          return this.finish(task, project, run.id, { status: 'blocked', blockedKind: 'auth_missing' },
            { agentMessage: '宿主 Codex 无法确认登录。请用当前运行账号执行 desk auth，再继续任务。', filesChanged: [], diffStat: '' }, logPath, undefined);
        }
      }

      // ② checkpoint：宿主侧执行（继承用户 LFS/filemode 配置，容器不再触碰 .git）
      const cp = await hostCheckpoint(project.workspace_path, task.id);
      const continuingGit = !!cp.gitOperation && isCapability && kind === 'resume';
      if (!cp.ok && !continuingGit) {
        return this.finish(task, project, run.id, { status: 'blocked', blockedKind: cp.gitOperation ? 'git_in_progress' : 'unknown_error' },
          { agentMessage: `checkpoint 失败：${cp.error}`, filesChanged: [], diffStat: '' }, logPath, undefined);
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
      const cmd = priorSession && feedback
        ? adapter.buildResumeArgs(priorSession, feedback, execution)
        : adapter.buildArgs(feedback ? `${task.prompt}\n\n${feedback}` : task.prompt, execution);

      let sessionId: string | undefined;
      let lastAgentText = '';
      let lastAgentError = '';
      const isNative = isCapability; // capability = 宿主原生执行
      // native 模式不透传容器 env（CODEX_HOME=/codex-home 是容器内路径，宿主不存在）
      const nativeEnv = hostCodexProxyEnv(cfg.proxy);
      const onLine = (line: string) => {
        record(line + '\n');
        const ev = adapter.parseLine(line);
        if (!ev) return;
        if (ev.type === 'session' && ev.sessionId && !sessionId) {
          sessionId = ev.sessionId;
          store.updateRun(run.id, { session_id: sessionId });
        }
        if (ev.type === 'agent_message' && ev.text) lastAgentText = ev.text;
        if (ev.type === 'error' && ev.text) lastAgentError = ev.text;
      };
      const main = isNative
        ? await this.runNativePath({
            adapterImage: adapter.image, cmd,
            cwd: project.workspace_path, env: nativeEnv,
            timeoutMs: tmo, tag: `run-${run.id}`,
            onStdoutLine: onLine,
            onPid: pid => store.updateRun(run.id, { worker: { kind: 'native', pid } }),
          })
        : await this.spawn({
            image: effectiveImage, cmd, binds, env, timeoutMs: tmo, tag: `run-${run.id}`,
            onStdoutLine: onLine,
            onContainer: id => store.updateRun(run.id, { worker: { kind: 'docker', id } }),
          });
      for (const l of main.err) record('[stderr] ' + l + '\n');

      // ④ 收尾：有未结束的 Git 操作时，留给用户根据草案继续。
      let result = classifyRun({
        exitCode: main.exitCode,
        killed: main.killed,
        lastAgentText,
        errTail: [...main.err.slice(-20), lastAgentError].join('\n'),
      });
      const pendingGit = isCapability ? await hostGitOperation(project.workspace_path) : undefined;
      const { filesChanged, diffStat } = await hostAudit(project.workspace_path, pendingGit ? '' : anchor);
      // 旧会话仍可能报告部分完成，保留未完成项供续跑。
      const report = parseResultMarker(lastAgentText);
      const summary: RunSummary = {
        agentMessage: result.status === 'blocked' ? lastAgentText || undefined
          : stripAgentctlLines(lastAgentText).trim() || report?.summary || undefined,
        filesChanged, diffStat, sessionId,
        partial: report ? !report.done : undefined,
        remaining: report?.remaining,
      };
      if (pendingGit && result.status === 'succeeded') {
        const reason = `Git 操作暂停（${pendingGit}）。请查看任务详情中的处理方案，再确认是否继续。`;
        record(`# ${reason}\n`);
        summary.agentMessage = [reason, summary.agentMessage].filter(Boolean).join('\n\n');
        result = { status: 'blocked', blockedKind: 'git_in_progress' };
      }
      this.finish(task, project, run.id, result, summary, logPath, main.exitCode);
    } catch (e: any) {
      this.finish(task, project, run.id,
        { status: 'failed', blockedKind: 'unknown_error' },
        { agentMessage: `runner 异常: ${e?.message ?? e}`, filesChanged: [], diffStat: '' }, logPath, undefined);
    } finally {
      cleanupConfig?.();
    }
  }

  private finish(
    task: Task, project: Project, runId: number,
    result: ReturnType<typeof classifyRun>, summary: RunSummary, logPath?: string, exitCode?: number,
  ): void {
    const { store, events } = this.deps;
    const retryViaCli = !!store.getMerge(task.id);
    store.finishRun(runId, {
      status: result.status,
      exit_code: exitCode,
      blocked_kind: result.blockedKind,
      summary_json: JSON.stringify(summary),
      ended_at: new Date().toISOString(),
      log_path: logPath,
    }, taskStatusAfterRun(task, store.getRun(runId)!, result),
    result.status === 'succeeded' && summary.partial ? summary.remaining ?? '（agent 未给出明细）' : null);

    if (result.status === 'succeeded') events.emit({ kind: 'run.succeeded', runId, task, project, summary });
    else if (result.status === 'blocked') {
      // 从协议标记行提取人话问题：###AGENTCTL_BLOCKED### {"question":"..."}
      let question = result.reason ?? (stripAgentctlLines(summary.agentMessage ?? '') || undefined);
      if (result.blockedKind === 'git_in_progress') question = question?.split('\n\n', 1)[0];
      if (result.blockedKind === 'missing_result') question = 'Codex 已退出，但没有返回任务答复。请查看日志后决定是否续跑。';
      const markerLine = summary.agentMessage?.split('\n').find(l => l.includes(AGENTCTL_MARKER));
      if (markerLine) {
        try {
          const j = JSON.parse(markerLine.slice(markerLine.indexOf(AGENTCTL_MARKER) + AGENTCTL_MARKER.length).trim());
          question = typeof j.question === 'string' ? j.question : typeof j.reason === 'string' ? j.reason : question;
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
      events.emit({ kind: 'run.blocked', runId, task, project, blockedKind: result.blockedKind!, question, retryViaCli });
    } else events.emit({ kind: 'run.failed', runId, task, project, reason: summary.agentMessage ?? 'unknown', retryViaCli });
  }
}
