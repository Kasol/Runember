/**
 * HTTP API（Fastify）—— CLI 与未来 Web GUI 的统一入口。
 * 鉴权：cfg.server.token 非空时要求 x-agentdesk-token 头（自托管默认关闭）。
 */
import Fastify, { FastifyInstance } from 'fastify';
import { availableAgents } from '@agentdesk/adapters';
import { readFileSync, createReadStream, existsSync } from 'node:fs';
import type { Notifier, TaskStatus } from '@agentdesk/core';
import type { AppConfig } from './config.js';
import type { Store } from './store.js';
import type { Scheduler } from './scheduler.js';
import { getAdapterId } from './util.js';
import { hostGitAvailable, setupProjectGit } from './hostgit.js';
import { checkIsolationCompatibility } from './platform.js';
import { extname, join } from 'node:path';
import { runDoctor } from './doctor.js';
import { DingTalkNotifier } from './dingtalk.js';
import { DingTalkAppNotifier } from './dingtalk-app.js';
import Docker from 'dockerode';
import type { MergePlan } from './merge.js';

export function buildServer(deps: {
  cfg: AppConfig; store: Store; scheduler: Scheduler; docker: Docker; notifiers: Notifier[];
  webDir?: string;
  control?: { instanceId: string; key: string; stop: () => void };
}): FastifyInstance {
  const { cfg, store, scheduler } = deps;
  const app = Fastify({ logger: false });
  const canManageMerge = (ip: string) =>
    !!cfg.server.token || ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);

  app.addHook('onRequest', async (req, reply) => {
    if (!cfg.server.token || !req.url.startsWith('/api/')) return;
    if (req.headers['x-agentdesk-token'] !== cfg.server.token) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/healthz', async () => ({ ok: true, ts: Date.now(), instanceId: deps.control?.instanceId }));

  if (deps.control) app.post('/api/shutdown', async (req, reply) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip) ||
        req.headers['x-agentdesk-control'] !== deps.control!.key) {
      return reply.code(403).send({ error: '请从本机使用 desk stop。' });
    }
    reply.raw.once('finish', deps.control!.stop);
    return reply.code(202).send({ ok: true });
  });

  const webDir = deps.webDir;
  if (webDir && existsSync(join(webDir, 'index.html'))) {
    app.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8')
      .header('cache-control', 'no-cache').send(createReadStream(join(webDir, 'index.html'))));
    app.get<{ Params: { name: string } }>('/assets/:name', async (req, reply) => {
      const name = req.params.name;
      const types: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
      const type = types[extname(name)];
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || !type || !existsSync(join(webDir, 'assets', name))) {
        return reply.code(404).send({ error: '资源不存在' });
      }
      return reply.type(type).header('cache-control', 'public, max-age=31536000, immutable')
        .send(createReadStream(join(webDir, 'assets', name)));
    });
  }

  app.get('/api/setup/check', async () => ({ report: await runDoctor(cfg) }));

  app.post<{ Body: MergePlan & { project: string } }>('/api/merge-tasks', async (req, reply) => {
    if (!canManageMerge(req.ip)) {
      return reply.code(403).send({ error: '远程自动合并需要 API token' });
    }
    const { project, source, base, test, retireDev = false } = req.body ?? {};
    if (typeof project !== 'string' || typeof source !== 'string' || typeof base !== 'string'
        || !source || !base || source === base || source.startsWith('-') || base.startsWith('-')
        || typeof test !== 'string' || !test.trim() || typeof retireDev !== 'boolean') {
      return reply.code(400).send({ error: '需要已注册项目、不同的源/目标分支及全量测试命令' });
    }
    const target = store.findProject(project);
    if (!target) return reply.code(404).send({ error: '项目不存在' });
    if (target.execution === 'isolation') return reply.code(400).send({ error: '自动化合并需要 capability 项目' });
    const task = store.addMergeTask(target.id, { source, base, test, retireDev });
    scheduler.tickNow();
    return reply.code(202).send({ task });
  });

  /** 通知通路测试：向所有已配置的外部渠道直接发一条测试消息 */
  app.post('/api/notify/test', async (_req, reply) => {
    const senders = deps.notifiers.filter((n): n is DingTalkNotifier | DingTalkAppNotifier =>
      n instanceof DingTalkNotifier || n instanceof DingTalkAppNotifier);
    if (!senders.length) return reply.code(400).send({ error: '未配置任何外部通知渠道（notify.channels）' });
    const results: Array<{ channel: string; ok: boolean; error?: string }> = [];
    for (const d of senders) {
      try {
        await d.sendRaw('🧪 agentdesk 通路测试',
          '### 🧪 agentdesk 通路测试\n\n收到这条消息 = 钉钉通知链路已打通 ✅');
        results.push({ channel: d.name, ok: true });
      } catch (e: any) {
        results.push({ channel: d.name, ok: false, error: e?.message ?? String(e) });
      }
    }
    return { results };
  });

  app.get('/api/agents', async () => ({ agents: availableAgents() }));

  // ── projects ──
  app.get('/api/projects', async () => ({ projects: store.listProjects() }));
  /** 项目配置更新：模式切换 / extraPackages / mcpServers —— 切到 isolation 时重新守门检测 */
  app.patch<{ Params: { id: string }; Body: { execution?: string; extraPackages?: string[]; mcpServers?: string[] } }>(
    '/api/projects/:id', async (req, reply) => {
      const p = store.getProject(Number(req.params.id));
      if (!p) return reply.code(404).send({ error: 'not found' });
      const { execution, extraPackages, mcpServers } = req.body ?? ({} as any);

      let nextExecution = execution ?? p.execution ?? 'capability';
      if (!['capability', 'isolation'].includes(nextExecution)) {
        return reply.code(400).send({ error: 'execution 必须是 capability|isolation' });
      }

      // 模式切换到 isolation → 重新跑守门检测（capability 无需，永远可切）
      let platformNote: string | undefined;
      if (nextExecution === 'isolation') {
        const plat = await checkIsolationCompatibility(p.workspace_path);
        if (!plat.ok) {
          return reply.code(409).send({
            error: `${plat.summary}。无法切换到隔离模式。建议保持 capability，或先移除项目中的 Windows 原生组件。`,
          });
        }
        platformNote = plat.summary;
      }

      const updated = store.updateProject(p.id, {
        execution: nextExecution,
        ...(extraPackages !== undefined ? { extraPackages } : {}),
        ...(mcpServers !== undefined ? { mcpServers } : {}),
      });
      return { project: updated, ...(platformNote ? { platform: platformNote } : {}) };
    },
  );

  /** 重新检测：清单工具 + （isolation 时）平台兼容性。返回可读的体检报告 */
  app.post<{ Params: { id: string } }>('/api/projects/:id/recheck', async (req, reply) => {
    const p = store.getProject(Number(req.params.id));
    if (!p) return reply.code(404).send({ error: 'not found' });
    const report = await runDoctor(cfg, { mode: p.execution, projectPath: p.workspace_path });
    if ((p.execution ?? 'capability') === 'isolation') {
      const plat = await checkIsolationCompatibility(p.workspace_path);
      report.push({ name: '平台兼容性（隔离模式）', ok: plat.ok, detail: plat.summary, required: true });
    }
    return { project: p, report };
  });

  /** 删除项目（不删任务历史；workspace 文件不受影响） */
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const p = store.getProject(Number(req.params.id));
    if (!p) return reply.code(404).send({ error: 'not found' });
    if (store.hasActiveTasks(p.id) || store.hasUnfinishedMerge(p.id)) {
      return reply.code(409).send({ error: '请先完成或取消这个项目的活动任务和未完成合并' });
    }
    store.deleteProject(p.id);
    return { ok: true, deleted: p.name };
  });

  app.post<{ Body: { name: string; workspace_path: string; agent_id?: string; execution?: 'capability' | 'isolation'; extraPackages?: string[]; mcpServers?: string[] } }>(
    '/api/projects', async (req, reply) => {
      const { name, workspace_path, agent_id = 'codex', execution = 'capability', extraPackages, mcpServers } = req.body ?? ({} as any);
      if (!name || !workspace_path) return reply.code(400).send({ error: 'name 与 workspace_path 必填' });
      if (!availableAgents().includes(agent_id)) return reply.code(400).send({ error: `未知 agent: ${agent_id}` });
      if (!['capability', 'isolation'].includes(execution)) return reply.code(400).send({ error: `execution 必须是 capability|isolation` });
      if (store.findProject(name)) return reply.code(409).send({ error: `项目名已存在: ${name}` });
      if (!existsSync(workspace_path)) return reply.code(400).send({ error: `路径不存在: ${workspace_path}` });
      if (extraPackages && !Array.isArray(extraPackages)) return reply.code(400).send({ error: 'extraPackages 必须是字符串数组' });

      // 宿主工具清单检查（所有模式共用：git 必须存在——安全网依赖）
      const gitInfo = await hostGitAvailable();
      if (!gitInfo.ok) {
        return reply.code(400).send({ error: '宿主机未安装 git —— agentdesk 的安全网（checkpoint）依赖它。请安装 git 后重试。' });
      }

      // isolation 模式守门员：检测 Linux 容器无法加载的组件，命中即拒绝并提示切换 capability
      let platformNote = '';
      if (execution === 'isolation') {
        const plat = await checkIsolationCompatibility(workspace_path);
        if (!plat.ok) {
          return reply.code(400).send({
            error: `${plat.summary}。隔离模式（Linux 容器）无法运行。建议：execution='capability'（能力优先，codex 直接跑宿主）后重试。`,
          });
        }
        platformNote = plat.summary;
      }

      const gitCfg = await setupProjectGit(workspace_path);
      const project = store.addProject(name, workspace_path, agent_id, execution, extraPackages, mcpServers);
      return reply.code(201).send({
        project,
        git: { version: gitInfo.version, config: gitCfg.message },
        ...(platformNote ? { platform: platformNote } : {}),
      });
    },
  );

  // ── tasks ──
  app.get<{ Querystring: { status?: TaskStatus } }>('/api/tasks', async (req) =>
    ({ tasks: store.listTasks(req.query?.status) }));

  app.post<{ Body: { project: string | number; prompt: string; draft?: boolean } }>(
    '/api/tasks', async (req, reply) => {
      const { project, prompt, draft } = req.body ?? ({} as any);
      if (!project || !prompt) return reply.code(400).send({ error: 'project 与 prompt 必填' });
      const p = typeof project === 'number'
        ? store.getProject(project)
        : store.findProject(project);
      if (!p) return reply.code(404).send({ error: `项目不存在: ${project}` });
    const task = store.addTask(p.id, prompt, { draft: !!draft });
    if (!draft) scheduler.tickNow();
    return reply.code(201).send({ task });
    },
  );

  /** 草稿操作：编辑 / 排序（移到某任务之前）/ 入队执行 */
  app.post<{ Params: { id: string }; Body: { op: 'edit' | 'moveBefore' | 'enqueue'; prompt?: string; beforeId?: number } }>(
    '/api/tasks/:id/draft', async (req, reply) => {
      const t = store.getTask(Number(req.params.id));
      if (!t) return reply.code(404).send({ error: 'not found' });
      if (t.status !== 'draft') return reply.code(409).send({ error: '仅 draft 任务可操作' });
      const { op, prompt, beforeId } = req.body ?? ({} as any);
      if (op === 'edit') {
        if (!prompt?.trim()) return reply.code(400).send({ error: 'prompt 不能为空' });
        store.updateTaskPrompt(t.id, prompt.trim());
      } else if (op === 'moveBefore') {
        store.reorderDraft(t.id, beforeId ?? null);
      } else if (op === 'enqueue') {
        store.setTaskStatus(t.id, 'queued');
        scheduler.tickNow();
      } else {
        return reply.code(400).send({ error: 'op 必须是 edit|moveBefore|enqueue' });
      }
      return { ok: true, task: store.getTask(t.id) };
    },
  );

  app.get('/api/drafts', async () => ({ drafts: store.listDrafts() }));

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const t = store.getTask(Number(req.params.id));
    if (!t) return reply.code(404).send({ error: 'not found' });
    const merge = store.getMerge(t.id);
    return { task: t, runs: store.runsOfTask(t.id), merge: merge && {
      repo: merge.state.repo, pr: merge.state.pr, verified: merge.state.verified, completed: merge.state.completed,
    } };
  });

  /** 反馈闭环入口：与钉钉 Stream 通道共用 applyTaskAction，语义完全一致 */
  app.post<{ Params: { id: string }; Body: { type: string; feedback?: string } }>(
    '/api/tasks/:id/actions', async (req, reply) => {
      const { type, feedback } = req.body ?? ({} as any);
      if (store.getMerge(Number(req.params.id)) && !canManageMerge(req.ip)) {
        return reply.code(403).send({ error: '远程自动合并需要 API token' });
      }
      const { applyTaskAction } = await import('./actions.js');
      const r = await applyTaskAction(store, scheduler,
        { type: type as any, taskId: Number(req.params.id), feedback });
      if (!r.ok) return reply.code(409).send({ error: r.message });
      return { ok: true, message: r.message, task: store.getTask(Number(req.params.id)) };
    },
  );

  // ── runs ──
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const r = store.getRun(Number(req.params.id));
    if (!r) return reply.code(404).send({ error: 'not found' });
    let logTail: string[] = [];
    try { logTail = readFileSync(r.log_path!, 'utf8').split('\n').slice(-50); } catch { /* 无日志 */ }
    return { run: r, logTail };
  });

  // ── auth：订阅凭证设备码登录（凭证写进 agent-home 卷） ──
  app.post<{ Body: { agent_id?: string } }>('/api/auth/login', async (req, reply) => {
    const agentId = req.body?.agent_id ?? 'codex';
    const adapter = getAdapterId(agentId, cfg);
    try { await deps.docker.getVolume(adapter.homeVolume).inspect(); }
    catch { await deps.docker.createVolume({ Name: adapter.homeVolume }); }

    const container = await deps.docker.createContainer({
      Image: adapter.image,
      Cmd: ['codex', 'login', '--device-auth'],
      Env: ['CODEX_HOME=/codex-home',
        ...(cfg.proxy.httpsProxy ? [`HTTPS_PROXY=${cfg.proxy.httpsProxy}`, `https_proxy=${cfg.proxy.httpsProxy}`] : [])],
      Labels: { 'agentdesk.auth': agentId },
      AttachStdout: true, AttachStderr: true,
      HostConfig: { Binds: [`${adapter.homeVolume}:/codex-home`] },
    });
    await container.start();
    // 等 10s 抓设备码后返回给调用方，容器留在后台等人完成浏览器授权
    await new Promise(r => setTimeout(r, 10_000));
    const logs = await container.logs({ stdout: true, stderr: true });
    let text = '';
    (logs as any).on?.('data', (c: Buffer) => { text += c.toString('utf8'); });
    await new Promise<void>(resolve => {
      const done = () => resolve();
      if ((logs as any).once) (logs as any).once('end', done); else done();
      setTimeout(done, 3_000);
    });
    const url = text.match(/https:\/\/auth\.openai\.com[^\s]*/)?.[0];
    const code = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{5})\b/)?.[1];
    void container.wait().then(() => console.log(`🔐 ${agentId} 登录容器已结束`));
    return { ok: true, url, code, note: '浏览器完成授权后凭证自动落卷，无需其他操作' };
  });

  return app;
}
