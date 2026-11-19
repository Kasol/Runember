/**
 * HTTP API（Fastify）—— CLI 与未来 Web GUI 的统一入口。
 * 鉴权：cfg.server.token 非空时要求 x-agentdesk-token 头（自托管默认关闭）。
 */
import Fastify, { FastifyInstance } from 'fastify';
import { availableAgents } from '@agentdesk/adapters';
import { readFileSync, createReadStream, existsSync } from 'node:fs';
import { runDetails, taskView, repeatedRunFailure, type Notifier, type TaskStatus } from '@agentdesk/core';
import type { AppConfig } from './config.js';
import type { Store } from './store.js';
import type { Scheduler } from './scheduler.js';
import { getAdapterId } from './util.js';
import { hostGitAvailable, setupProjectGit } from './hostgit.js';
import { checkIsolationCompatibility } from './platform.js';
import { extname, join, resolve } from 'node:path';
import { runDoctor, groupDoctorChecks } from './doctor.js';
import { DingTalkNotifier } from './dingtalk.js';
import { DingTalkAppNotifier } from './dingtalk-app.js';
import Docker from 'dockerode';
import type { MergePlan } from './merge.js';
import { listProjectFolders, ProjectFolderError } from './project-folders.js';
import { readRunLog } from './run-log.js';
import { applyTaskAction, availableTaskActions } from './actions.js';
import { DingTalkLanguage } from './dingtalk-language.js';
import { agentCatalog, runtimeConfig, validateAgentPath, refreshAgentDiscovery, validateReasoningEffort, reasoningCapabilities } from './agent-runtime.js';
import { agentDefinitions } from '@agentdesk/adapters';
import { logSettings, validateLogDirectory } from './log-settings.js';
import { diagnoseTask, diagnoseEnvironment } from './diagnostics.js';
import { networkSettings, saveNetworkSettings, testNativeConnection, validateNativeProxy } from './network-settings.js';

export function buildServer(deps: {
  cfg: AppConfig; store: Store; scheduler: Scheduler; docker: Docker; notifiers: Notifier[];
  webDir?: string;
  control?: { instanceId: string; key: string; stop: () => void };
}): FastifyInstance {
  const { cfg, store, scheduler } = deps;
  const app = Fastify({ logger: false });
  const isLoopback = (ip: string) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
  const canManageMerge = (ip: string) => !!cfg.server.token || isLoopback(ip);

  app.addHook('onRequest', async (req, reply) => {
    if (!cfg.server.token || !req.url.startsWith('/api/')) return;
    if (req.headers['x-agentdesk-token'] !== cfg.server.token) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/healthz', async () => ({ ok: true, ts: Date.now(), instanceId: deps.control?.instanceId }));

  if (deps.control) app.post('/api/shutdown', async (req, reply) => {
    if (!isLoopback(req.ip) ||
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

  app.get('/api/setup/check', async () => ({ report: await runDoctor(runtimeConfig(cfg, store)) }));
  app.get('/api/diagnostics', async (_req, reply) => reply.header('cache-control', 'no-store').send(await diagnoseEnvironment(cfg)));
  app.get<{ Params: { id: string }; Querystring: { run?: string } }>('/api/tasks/:id/diagnostics', async (req, reply) => {
    const task = store.getTask(Number(req.params.id));
    if (!task) return reply.code(404).send({ error: '任务不存在' });
    const runId = req.query.run === undefined ? undefined : Number(req.query.run);
    if (runId !== undefined && (!Number.isSafeInteger(runId) || runId < 1)) return reply.code(400).send({ error: '无效的 Run 编号' });
    const run = runId === undefined ? store.latestRun(task.id) : store.getRun(runId);
    if (runId !== undefined && (!run || run.task_id !== task.id)) return reply.code(404).send({ error: '该 Run 不属于当前任务' });
    return reply.header('cache-control', 'no-store').send(await diagnoseTask(task, run));
  });

  app.get('/api/settings/storage', async (_req, reply) => reply.header('cache-control', 'no-store').send(logSettings(cfg, store)));
  app.get('/api/settings/network', async (_req, reply) => reply.header('cache-control', 'no-store').send(networkSettings(cfg, store)));
  for (const test of [false, true]) app.route<{ Body: { url?: unknown } }>({
    method: test ? 'POST' : 'PATCH', url: test ? '/api/settings/network/test' : '/api/settings/network',
    handler: async (req, reply) => {
      const localOrigin = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname.toLowerCase()) &&
        [`http://${req.host}`, `https://${req.host}`].includes(req.headers.origin ?? '');
      if (!cfg.server.token && (!isLoopback(req.ip) || !!req.headers.origin && !localOrigin)) return reply.code(403).send({ error: '修改代理或检测连接需要本机看板或连接密钥' });
      try {
        if (test) {
          const value = validateNativeProxy(req.body?.url);
          const probeConfig = value ? { ...cfg, proxy: { ...cfg.proxy, nativeHttpsProxy: value, nativeHttpProxy: value } } : cfg;
          return await testNativeConnection(probeConfig);
        }
        saveNetworkSettings(store, req.body?.url);
        return networkSettings(cfg, store);
      } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    },
  });
  app.patch<{ Body: { logDir?: unknown } }>('/api/settings/storage', async (req, reply) => {
    const localOrigin = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname.toLowerCase()) &&
      [`http://${req.host}`, `https://${req.host}`].includes(req.headers.origin ?? '');
    if (!cfg.server.token && (!isLoopback(req.ip) || (!!req.headers.origin && !localOrigin))) {
      return reply.code(403).send({ error: '修改日志目录需要本机看板或连接密钥' });
    }
    if (typeof req.body?.logDir !== 'string') return reply.code(400).send({ error: 'logDir 必须为目录字符串' });
    try {
      store.setSetting('storage.logDir', validateLogDirectory(req.body.logDir));
      return logSettings(cfg, store);
    } catch (error) {
      return reply.code(400).send({ error: `无法使用此日志目录：${(error as Error).message}` });
    }
  });

  app.get('/api/settings/dingtalk', async () => ({ language: new DingTalkLanguage(store).preference() }));
  app.patch<{ Body: { language?: unknown } }>('/api/settings/dingtalk', async (req, reply) => {
    if (!cfg.server.token && !isLoopback(req.ip)) {
      return reply.code(403).send({ error: '远程修改钉钉设置需要 API token' });
    }
    const language = req.body?.language;
    if (language !== 'auto' && language !== 'zh-CN' && language !== 'en') {
      return reply.code(400).send({ error: 'language 必须为 auto、zh-CN 或 en' });
    }
    store.setSetting('dingtalk.language', language);
    return { language };
  });

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
    return reply.code(202).send({ task: taskView(task) });
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

  app.get<{ Querystring: { refresh?: string } }>('/api/agents', async req => {
    if (req.query.refresh === '1') refreshAgentDiscovery();
    return { agents: availableAgents(), details: agentCatalog(runtimeConfig(cfg, store)) };
  });
  app.patch<{ Params: { id: string }; Body: { executable?: unknown } }>('/api/settings/agents/:id', async (req, reply) => {
    const localOrigin = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname.toLowerCase()) &&
      [`http://${req.host}`, `https://${req.host}`].includes(req.headers.origin ?? '');
    if (!cfg.server.token && (!isLoopback(req.ip) || (!!req.headers.origin && !localOrigin))) {
      return reply.code(403).send({ error: '修改 Agent 执行路径需要本机看板或连接密钥' });
    }
    const { id } = req.params;
    if (!agentDefinitions.some(agent => agent.id === id)) return reply.code(404).send({ error: 'Agent 不存在' });
    if (typeof req.body?.executable !== 'string') return reply.code(400).send({ error: 'executable 必须为路径字符串，留空恢复自动检测' });
    try {
      const path = req.body.executable.trim() ? validateAgentPath(id, req.body.executable, cfg) : '';
      store.setSetting(`agents.${id}.executable`, path);
      return { details: agentCatalog(runtimeConfig(cfg, store)) };
    } catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });

  // ── projects ──
  app.get('/api/projects', async () => ({ projects: store.listProjects() }));

  app.post<{ Body: { path?: string } }>('/api/project-folders', async (req, reply) => {
    const localOrigin = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname.toLowerCase()) &&
      [`http://${req.host}`, `https://${req.host}`].includes(req.headers.origin ?? '');
    if (!cfg.server.token && (!isLoopback(req.ip) || !localOrigin)) {
      return reply.code(403).send({ error: '浏览主机文件夹需要本机看板或连接密钥' });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return reply.code(400).send({ error: '无效的文件夹选择请求' });
    }
    try {
      return reply.header('cache-control', 'no-store').send(await listProjectFolders(req.body.path));
    } catch (error) {
      if (error instanceof ProjectFolderError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });

  /** 项目配置更新：模式切换 / extraPackages / mcpServers —— 切到 isolation 时重新守门检测 */
  app.get<{ Params: { id: string }; Querystring: { model?: string } }>('/api/agents/:id/reasoning', async (req, reply) => {
    if (!availableAgents().includes(req.params.id)) return reply.code(400).send({ error: '未知 Agent' });
    if (req.query.model && (req.query.model.length > 256 || /[\r\n\0]/.test(req.query.model))) return reply.code(400).send({ error: '模型名称无效' });
    return reasoningCapabilities(runtimeConfig(cfg, store), req.params.id, req.query.model);
  });

  app.patch<{ Params: { id: string }; Body: { agent_id?: string; model?: string | null; reasoning_effort?: string | null; execution?: string; extraPackages?: string[]; mcpServers?: string[] } }>(
    '/api/projects/:id', async (req, reply) => {
      const p = store.getProject(Number(req.params.id));
      if (!p) return reply.code(404).send({ error: 'not found' });
      const { agent_id, model, reasoning_effort, execution, extraPackages, mcpServers } = req.body ?? ({} as any);
      const nextAgent = agent_id ?? p.agent_id;
      if (!availableAgents().includes(nextAgent)) return reply.code(400).send({ error: `未知 agent: ${nextAgent}` });
      if (model !== undefined && model !== null && (typeof model !== 'string' || !model.trim() || model.length > 256 || /[\r\n\0]/.test(model))) return reply.code(400).send({ error: '模型名称必须为 1–256 个字符的单行文本，留空使用默认模型。' });
      if ((nextAgent !== p.agent_id || (model !== undefined && model !== p.model) || (reasoning_effort !== undefined && reasoning_effort !== p.reasoning_effort)) && store.hasActiveTasks(p.id)) return reply.code(409).send({ error: '请先完成或取消该项目的排队、运行中任务，再修改 Agent、模型或推理强度。' });

      let nextExecution = execution ?? p.execution ?? 'capability';
      if (!['capability', 'isolation'].includes(nextExecution)) {
        return reply.code(400).send({ error: 'execution 必须是 capability|isolation' });
      }
      if (!(agentDefinitions.find(agent => agent.id === nextAgent)?.modes as readonly string[])?.includes(nextExecution)) return reply.code(400).send({ error: `${nextAgent} 当前仅支持能力优先模式。` });
      const nextModel = model === undefined ? (nextAgent === p.agent_id ? p.model : null) : model;
      if (nextAgent === 'zcode' && nextModel && !/^[^/]+\/.+/.test(nextModel)) return reply.code(400).send({ error: 'ZCode 模型请使用 provider/model 格式，或从建议列表选择。' });
      let nextReasoning: string | null;
      try { nextReasoning = validateReasoningEffort(runtimeConfig(cfg, store), nextAgent, nextModel,
        reasoning_effort === undefined ? (nextAgent === p.agent_id && (nextModel ?? null) === (p.model ?? null) ? p.reasoning_effort : null) : reasoning_effort); }
      catch (error) { return reply.code(400).send({ error: (error as Error).message }); }

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
        agent_id: nextAgent, model: nextModel, reasoning_effort: nextReasoning,
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
    const report = groupDoctorChecks(await runDoctor(runtimeConfig(cfg, store), { mode: p.execution, projectPath: p.workspace_path, agentId: p.agent_id }));
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

  app.post<{ Body: { name: string; workspace_path: string; agent_id?: string; model?: string | null; reasoning_effort?: string | null; execution?: 'capability' | 'isolation'; extraPackages?: string[]; mcpServers?: string[] } }>(
    '/api/projects', async (req, reply) => {
      const { name, workspace_path, agent_id = 'codex', model, reasoning_effort, execution = 'capability', extraPackages, mcpServers } = req.body ?? ({} as any);
      if (!name || !workspace_path) return reply.code(400).send({ error: 'name 与 workspace_path 必填' });
      if (!availableAgents().includes(agent_id)) return reply.code(400).send({ error: `未知 agent: ${agent_id}` });
      if (!['capability', 'isolation'].includes(execution)) return reply.code(400).send({ error: `execution 必须是 capability|isolation` });
      if (!(agentDefinitions.find(agent => agent.id === agent_id)?.modes as readonly string[])?.includes(execution)) return reply.code(400).send({ error: `${agent_id} 当前仅支持能力优先模式。` });
      if (model !== undefined && model !== null && (typeof model !== 'string' || !model.trim() || model.length > 256 || /[\r\n\0]/.test(model))) return reply.code(400).send({ error: '模型名称必须为 1–256 个字符的单行文本，留空使用默认模型。' });
      if (agent_id === 'zcode' && model && !/^[^/]+\/.+/.test(model)) return reply.code(400).send({ error: 'ZCode 模型请使用 provider/model 格式，或从建议列表选择。' });
      let selectedReasoning: string | null;
      try { selectedReasoning = validateReasoningEffort(runtimeConfig(cfg, store), agent_id, model, reasoning_effort); }
      catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
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
      const project = store.addProject(name, workspace_path, agent_id, execution, extraPackages, mcpServers, model, selectedReasoning);
      return reply.code(201).send({
        project,
        git: { version: gitInfo.version, config: gitCfg.message },
        ...(platformNote ? { platform: platformNote } : {}),
      });
    },
  );

  // ── tasks ──
  app.get<{ Querystring: { status?: TaskStatus } }>('/api/tasks', async (req) =>
    ({ tasks: store.listTaskViews(req.query?.status) }));

  app.post<{ Body: { project: string | number; prompt: string; draft?: boolean } }>(
    '/api/tasks', async (req, reply) => {
      const { project, prompt, draft } = req.body ?? ({} as any);
      if (!project || typeof prompt !== 'string' || !prompt.trim()) {
        return reply.code(400).send({ error: 'project 与 prompt 必填' });
      }
      const p = typeof project === 'number'
        ? store.getProject(project)
        : store.findProject(project);
      if (!p) return reply.code(404).send({ error: `项目不存在: ${project}` });
      const task = store.addTask(p.id, prompt, { draft: !!draft });
      if (!draft) scheduler.tickNow();
      return reply.code(201).send({ task: taskView(task) });
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
        if (typeof prompt !== 'string' || !prompt.trim()) return reply.code(400).send({ error: 'prompt 不能为空' });
        store.updateTaskPrompt(t.id, prompt);
      } else if (op === 'moveBefore') {
        store.reorderDraft(t.id, beforeId ?? null);
      } else if (op === 'enqueue') {
        store.setTaskStatus(t.id, 'queued');
        scheduler.tickNow();
      } else {
        return reply.code(400).send({ error: 'op 必须是 edit|moveBefore|enqueue' });
      }
      return { ok: true, task: taskView(store.getTask(t.id)!) };
    },
  );

  app.get('/api/drafts', async () => ({ drafts: store.listDrafts().map(task => taskView(task)) }));

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
    const t = store.getTask(Number(req.params.id));
    if (!t) return reply.code(404).send({ error: 'not found' });
    const merge = store.getMerge(t.id);
    const runs = store.runsOfTask(t.id);
    const last = runs.at(-1);
    const agentId = t.agent_id ?? 'codex';
    return {
      task: taskView(t, last), runs, agentId,
      details: last && runDetails(last, agentId, t.partial_remaining),
      repeatedFailure: repeatedRunFailure(runs),
      reportDeliveries: runs.flatMap(run => store.reportDeliveries(run.id)),
      actions: merge && !canManageMerge(req.ip)
        ? { resume: false, retry: false, cancel: false } : availableTaskActions(store, t),
      merge: merge && { repo: merge.state.repo, pr: merge.state.pr, verified: merge.state.verified, completed: merge.state.completed },
    };
  });

  /** 反馈闭环入口：与钉钉 Stream 通道共用 applyTaskAction，语义完全一致 */
  app.post<{ Params: { id: string }; Body: { runId?: number } }>('/api/tasks/:id/report/retry', async (req, reply) => {
    const localOrigin = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname.toLowerCase()) &&
      [`http://${req.host}`, `https://${req.host}`].includes(req.headers.origin ?? '');
    if (!cfg.server.token && (!isLoopback(req.ip) || !!req.headers.origin && !localOrigin)) return reply.code(403).send({ error: '重试报告需要本机看板或连接密钥' });
    const task = store.getTask(Number(req.params.id));
    if (!task) return reply.code(404).send({ error: '任务不存在' });
    const runId = req.body?.runId;
    if (!Number.isSafeInteger(runId) || !runId || runId < 1) return reply.code(400).send({ error: '请输入有效的 Run 编号' });
    const run = store.getRun(runId);
    if (!run || run.task_id !== task.id) return reply.code(404).send({ error: '该 Run 不属于当前任务' });
    return { scheduled: deps.notifiers.reduce((count, notifier) => count + (notifier.retryReport?.(runId) ?? 0), 0) };
  });

  app.post<{ Params: { id: string }; Body: { type: string; feedback?: string; runId?: number } }>(
    '/api/tasks/:id/actions', async (req, reply) => {
      const { type, feedback, runId } = req.body ?? ({} as any);
      if (runId !== undefined && (!Number.isSafeInteger(runId) || runId < 1)) {
        return reply.code(400).send({ error: '请输入有效的 Run 编号' });
      }
      if (store.getMerge(Number(req.params.id)) && !canManageMerge(req.ip)) {
        return reply.code(403).send({ error: '远程自动合并需要 API token' });
      }
      const r = await applyTaskAction(store, scheduler,
        { type: type as any, taskId: Number(req.params.id), feedback, runId });
      if (!r.ok) return reply.code(409).send({ error: r.message });
      const task = store.getTask(Number(req.params.id));
      return { ok: true, message: r.message, task: task && taskView(task, store.latestRun(task.id)) };
    },
  );

  // ── runs ──
  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req, reply) => {
    const r = store.getRun(Number(req.params.id));
    if (!r) return reply.code(404).send({ error: 'not found' });
    let logTail: string[] = [];
    if (r.log_path) {
      try { logTail = readFileSync(r.log_path, 'utf8').split('\n').slice(-50); } catch { /* 无日志 */ }
    }
    return { run: r, logTail };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/log/location', async (req, reply) => {
    if (!isLoopback(req.ip)) return reply.code(403).send({ error: '只能在 daemon 主机上打开日志位置' });
    const run = store.getRun(Number(req.params.id));
    if (!run?.log_path) return reply.code(404).send({ error: '暂无这次运行的日志' });
    return reply.header('cache-control', 'no-store').send({ path: run.log_path });
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string } }>('/api/runs/:id/log', async (req, reply) => {
    const run = store.getRun(Number(req.params.id));
    if (!run?.log_path) return reply.code(404).send({ error: '暂无这次运行的日志' });
    const value = req.query.before;
    const before = value === undefined ? undefined : Number(value);
    if (value !== undefined && (typeof value !== 'string' || !/^\d+$/.test(value) ||
        !Number.isSafeInteger(before) || !before)) {
      return reply.code(400).send({ error: '无效的日志位置' });
    }
    try { return reply.header('cache-control', 'no-store').send(await readRunLog(run.log_path, before)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ error: '日志文件已找不到' });
      return reply.code(500).send({ error: '无法读取日志文件' });
    }
  });

  app.get('/api/logs/daemon/location', async (req, reply) => {
    if (!isLoopback(req.ip)) return reply.code(403).send({ error: '只能在 daemon 主机上打开日志位置' });
    return reply.header('cache-control', 'no-store').send({ path: resolve(cfg.logDir, 'daemon.log') });
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
