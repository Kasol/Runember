/**
 * HTTP API（Fastify）—— CLI 与未来 Web GUI 的统一入口。
 * 鉴权：cfg.server.token 非空时要求 x-agentdesk-token 头（自托管默认关闭）。
 */
import Fastify, { FastifyInstance } from 'fastify';
import { availableAgents } from '@agentdesk/adapters';
import { readFileSync, existsSync } from 'node:fs';
import type { Notifier, TaskStatus } from '@agentdesk/core';
import type { AppConfig } from './config.js';
import type { Store } from './store.js';
import type { Scheduler } from './scheduler.js';
import { getAdapterId } from './util.js';
import { hostGitAvailable, setupProjectGit } from './hostgit.js';
import { checkIsolationCompatibility } from './platform.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DingTalkNotifier } from './dingtalk.js';
import { DingTalkAppNotifier } from './dingtalk-app.js';
import Docker from 'dockerode';

export function buildServer(deps: {
  cfg: AppConfig; store: Store; scheduler: Scheduler; docker: Docker; notifiers: Notifier[];
}): FastifyInstance {
  const { cfg, store, scheduler } = deps;
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req, reply) => {
    if (!cfg.server.token || req.url === '/healthz') return;
    if (req.headers['x-agentdesk-token'] !== cfg.server.token) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/healthz', async () => ({ ok: true, ts: Date.now() }));

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

    const report: Array<{ name: string; ok: boolean; detail: string }> = [];

    // ① 宿主工具清单
    const gitInfo = await hostGitAvailable();
    report.push({ name: '宿主 git', ok: gitInfo.ok, detail: gitInfo.ok ? gitInfo.version : '未安装（安全网依赖）' });

    // ② 执行模式相关
    if ((p.execution ?? 'capability') === 'isolation') {
      const plat = await checkIsolationCompatibility(p.workspace_path);
      report.push({ name: '平台兼容性（隔离模式）', ok: plat.ok, detail: plat.summary });
      if (!plat.ok) {
        report.push({ name: '建议', ok: false, detail: "切换 execution='capability'（PATCH /api/projects/<id>）" });
      }
    } else {
      report.push({ name: '执行模式', ok: true, detail: 'capability（宿主原生执行，无平台限制）' });
    }

    // ③ 凭证
    const isCap = (p.execution ?? 'capability') === 'capability';
    const authPath = join(process.env.USERPROFILE ?? homedir(), '.codex', 'auth.json');
    report.push({ name: 'Codex 凭证', ok: existsSync(authPath), detail: existsSync(authPath) ? 'auth.json 存在' : '缺失（重新登录）' });

    // ④ 项目路径
    report.push({ name: '项目路径', ok: existsSync(p.workspace_path), detail: p.workspace_path });

    return { project: p, report };
  });

  /** 删除项目（不删任务历史；workspace 文件不受影响） */
  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const p = store.getProject(Number(req.params.id));
    if (!p) return reply.code(404).send({ error: 'not found' });
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
      return reply.code(201).send({ task: store.addTask(p.id, prompt, { draft: !!draft }) });
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
    return { task: t, runs: store.runsOfTask(t.id) };
  });

  /** 反馈闭环入口：与钉钉 Stream 通道共用 applyTaskAction，语义完全一致 */
  app.post<{ Params: { id: string }; Body: { type: string; feedback?: string } }>(
    '/api/tasks/:id/actions', async (req, reply) => {
      const { type, feedback } = req.body ?? ({} as any);
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
