/**
 * agentdesk CLI（desk）—— daemon 的命令行驾驶舱。
 * 用法: npm run desk -- <command>
 *   project add <name> <绝对路径> [--agent codex]
 *   run <projectName> "任务指令"
 *   status [taskId]
 *   activity <taskId>
 *   resume <taskId> "反馈"
 *   retry <taskId> / cancel <taskId>
 *   auth [codex]
 */
import { taskDescriptions, agentLabel, runStage, runTiming, reasoningLabel, taskStateLabel, taskRunStateLabel, runReplyPresentation, runLimitLabel, validateTaskTimeout, failureHint, type TaskView, type Project, type Run, type RunDetails, type TaskActions } from '@agentdesk/core';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadLocalEnv } from '../../daemon/src/config.js';
import { loginHostCodex } from '../../daemon/src/native.js';
import { localAddress, startDaemon, stopDaemon } from './launcher.js';
import { APP_VERSION } from '../../daemon/src/version.js';

let BASE: string;
let TOKEN: string;

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-agentdesk-token': TOKEN } : {}) },
    body: body !== undefined ? JSON.stringify(body) : method === 'POST' ? '{}' : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`✗ API ${res.status}: ${JSON.stringify(data)}`);
    process.exit(1);
  }
  return data;
}

const S = (s: string): string => JSON.stringify(s);

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  let cfg: ReturnType<typeof loadConfig>;
  try {
    loadLocalEnv();
    cfg = loadConfig({ port: process.env.AGENTDESK_PORT ? Number(process.env.AGENTDESK_PORT) : undefined });
  } catch (error) {
    if (cmd === 'doctor' && rest.includes('--json')) {
      console.log(JSON.stringify({ schemaVersion: 1, product: 'Runember', scope: 'environment', generatedAt: new Date().toISOString(),
        platform: { os: process.platform, arch: process.arch, node: process.version, version: APP_VERSION },
        findings: [{ code: 'configuration_invalid', level: 'error', certainty: 'confirmed', title: '运行配置无法读取',
          detail: '配置文件、环境变量格式或配置字段无效。为避免泄露密钥，诊断不会展示配置原文。', evidence: [],
          suggestions: ['检查 config.json 的 JSON 语法及 .env 格式。', '核对端口、数据目录和已配置的环境变量字段；保留原文件副本后再修改。'] }] }, null, 2));
      process.exitCode = 1; return;
    }
    throw error;
  }
  BASE = localAddress(cfg);
  TOKEN = process.env.AGENTDESK_TOKEN ?? cfg.server.token;

  switch (cmd) {
    case 'start':
      await startDaemon(cfg, !rest.includes('--no-browser'));
      return;
    case 'stop':
      await stopDaemon(cfg, TOKEN);
      return;
    case 'logs': {
      const file = join(cfg.logDir, 'daemon.log');
      console.log(readFileSync(file, 'utf8').trimEnd().split('\n').slice(-100).join('\n'));
      return;
    }
    case 'project': {
      const [sub] = rest;
      if (sub === 'list') {
        const { projects } = await api('GET', '/api/projects') as { projects: Project[] };
        for (const p of projects) console.log(`#${p.id} ${p.name} [${p.execution ?? 'capability'}] ${agentLabel(p.agent_id)} / ${p.model || '默认模型'} · ${reasoningLabel(p.reasoning_effort)} · ${p.workspace_path}`);
        return;
      }
      const { values, positionals } = parseArgs({ args: rest.slice(1), allowPositionals: true,
        options: { agent: { type: 'string' }, model: { type: 'string' }, 'reasoning-effort': { type: 'string' }, execution: { type: 'string' } } });
      const [name, path] = positionals;
      if (sub === 'set' && name) {
        const { projects } = await api('GET', '/api/projects') as { projects: Project[] };
        const p = projects.find(project => project.name === name);
        if (!p) throw new Error(`项目不存在: ${name}`);
        const { project } = await api('PATCH', `/api/projects/${p.id}`, {
          ...(values.agent && { agent_id: values.agent }),
          ...(values.model !== undefined && { model: values.model.trim() || null }),
          ...(values['reasoning-effort'] !== undefined && { reasoning_effort: values['reasoning-effort'] === 'auto' ? null : values['reasoning-effort'] }),
          ...(values.execution && { execution: values.execution }),
        });
        console.log(`✅ ${project.name} · ${agentLabel(project.agent_id)} / ${project.model || '默认模型'} · ${reasoningLabel(project.reasoning_effort)}`);
        return;
      }
      if (sub !== 'add' || !name || !path || positionals.length !== 2) {
        console.log('用法: desk project list | project add <名称> <绝对路径> [--agent codex|zcode|deepseek] [--model 模型] [--reasoning-effort 强度|auto] | project set <名称> [--agent ...] [--model ...] [--reasoning-effort 强度|auto]');
        return;
      }
      const agent_id = values.agent ?? 'codex';
      const { project } = await api('POST', '/api/projects', { name, workspace_path: path, agent_id, model: values.model?.trim() || null,
        reasoning_effort: values['reasoning-effort'] === 'auto' ? null : values['reasoning-effort'], execution: values.execution ?? 'capability' });
      console.log(`✅ 项目已注册 #${project.id} ${project.name} → ${project.workspace_path} (agent: ${project.agent_id})`);
      return;
    }
    case 'agents': {
      if (rest[0] === 'set') {
        const [, id, ...parts] = rest;
        if (!id || !parts.length) throw new Error('用法: desk agents set <agent> <CLI 绝对路径|auto>');
        await api('PATCH', `/api/settings/agents/${encodeURIComponent(id)}`, { executable: parts.join(' ') === 'auto' ? '' : parts.join(' ') });
        console.log('✅ 执行路径已保存，下一轮任务生效。');
      }
      const { details } = await api('GET', '/api/agents');
      for (const agent of details) console.log(`${agent.available ? '✅' : '⚪'} ${agent.id} · ${agent.label} · ${agent.available ? '已检测到 CLI' : '未检测到 CLI'}${agent.defaultModel ? ' · 默认 ' + agent.defaultModel : ''}\n  CLI: ${agent.executable || agent.configuredPath || '未检测到'}`);
      return;
    }
    case 'draft': {
      const {values,positionals}=parseArgs({args:rest,allowPositionals:true,options:{'timeout-min':{type:'string'}}});
      const timeout_min=values['timeout-min']===undefined?undefined:validateTaskTimeout(Number(values['timeout-min']));
      const [sub, idOrProject, ...text] = positionals;
      if (sub === 'list') {
        const { drafts } = await api('GET', '/api/drafts') as { drafts: TaskView[] };
        for (const draft of drafts) console.log(`#${draft.id} · ${agentLabel(draft.agent_id)} · ${draft.prompt}`);
        return;
      }
      const prompt = text.join(' ');
      if (sub === 'add' && idOrProject && prompt.trim()) {
        const { task } = await api('POST', '/api/tasks', { project: idOrProject, prompt, draft: true, timeout_min });
        console.log(`草稿 #${task.id} 已保存。`);
        return;
      }
      if (idOrProject && /^#?\d+$/.test(idOrProject) && ((sub === 'edit' && prompt.trim()) || sub === 'run')) {
        const id = Number(idOrProject.replace(/^#/, ''));
        await api('POST', `/api/tasks/${id}/draft`, sub === 'edit' ? { op: 'edit', prompt, timeout_min } : { op: 'enqueue', timeout_min });
        console.log(`草稿 #${id} ${sub === 'edit' ? '已更新' : '已入队'}。`);
        return;
      }
      throw new Error('用法: desk draft list | draft add <项目> <描述> | draft edit <编号> <描述> | draft run <编号>');
    }
    case 'run': {
      const {values,positionals}=parseArgs({args:rest,allowPositionals:true,options:{'timeout-min':{type:'string'}}});
      const timeout_min=values['timeout-min']===undefined?null:validateTaskTimeout(Number(values['timeout-min']));
      const [project, ...promptParts] = positionals;
      const prompt = promptParts.join(' ');
      if (!project || !prompt) { console.log('用法: desk run <projectName> "任务指令" [--timeout-min 分钟]'); return; }
      const { task } = await api('POST', '/api/tasks', { project, prompt, timeout_min });
      console.log(`📋 任务已入队 #${task.id}（项目 ${project}）`);
      console.log(`   查看进度: npm run desk -- status ${task.id}`);
      return;
    }
    case 'merge': {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true,
        options: {
          source: { type: 'string' }, base: { type: 'string' }, test: { type: 'string' },
          'retire-dev': { type: 'boolean', default: false },
        },
      });
      if (positionals.length !== 1 || !values.source || !values.base || !values.test?.trim()) {
        throw new Error('用法: desk merge <项目> --source <dev> --base <目标> --test "<全量测试命令>" [--retire-dev]');
      }
      const { task } = await api('POST', '/api/merge-tasks', {
        project: positionals[0], source: values.source, base: values.base, test: values.test, retireDev: values['retire-dev'],
      });
      console.log(`自动化合并已入队 #${task.id}。查看进度: npm run desk -- status ${task.id}`);
      return;
    }
    case 'proxy': {
      if (!rest.length) {
        const settings = await api('GET', '/api/settings/network');
        console.log(`宿主 Agent HTTPS 代理 · ${settings.httpsProxy || '未指定，沿用进程环境'}`);
        console.log('desk proxy set <http://主机:端口|auto> | desk proxy test');
        return;
      }
      if (rest[0] === 'set' && rest[1] && rest.length === 2) {
        await api('PATCH', '/api/settings/network', { url: rest[1] === 'auto' ? '' : rest[1] });
        console.log('✅ 已保存，下一轮宿主任务生效。'); return;
      }
      if (rest[0] === 'test' && rest.length === 1) {
        const settings = await api('GET', '/api/settings/network');
        const result = await api('POST', '/api/settings/network/test', { url: settings.url });
        console.log(`${result.ok ? '✅' : '❌'} ${result.message}`); if (!result.ok) process.exitCode = 1; return;
      }
      throw new Error('用法: desk proxy | proxy set <地址|auto> | proxy test');
    }
    case 'status': {
      const id = rest[0] ? Number(rest[0].replace(/^#/, '')) : undefined;
      if (rest[0] && (!id || !Number.isSafeInteger(id) || id < 1)) throw new Error('请输入有效任务编号');
      if (id) {
        const { task, runs, details, repeatedFailure, actions, agentId, merge } = await api('GET', `/api/tasks/${id}`) as {
          task: TaskView; runs: Run[]; details?: RunDetails; repeatedFailure?: { count: number; hint: string }; actions: TaskActions; agentId?: string;
          merge?: { repo?: string; pr?: number; completed?: string };
        };
        console.log(`任务 #${task.id} [${taskRunStateLabel(task, details)}]`);
        if (task.state === 'running') console.log(`查看 Agent 进展 · desk activity ${id}`);
        if (repeatedFailure) console.log(`💡 连续 ${repeatedFailure.count} 轮出现同类故障。${repeatedFailure.hint}仍可主动续跑。`);
        if (task.confirmation) console.log(`请确认\n${task.confirmation}\n`);
        if (details) {
          console.log(runTiming(details));
          console.log(runLimitLabel(details.limits));
          const response = runReplyPresentation(details);
          if (response.notice) console.log(response.notice);
          if (details.network) console.log(`启动时 HTTPS 代理 · ${details.network.httpsProxy || '未指定'}`);
          if ((details.connection?.state === 'retrying' || details.connection?.state === 'inactive') && task.state === 'running') console.log(`${details.stage} · ${details.connection.reason}\n观察起点 · ${details.connection.since}\n最近可见活动 · ${details.connection.lastVisibleActivityAt ?? details.connection.lastProgressAt}\n执行器仍在运行，可查看日志或主动取消。`);
          if (details.cancellationRequestedAt) {
            console.log(`请求取消 · ${details.cancellationRequestedAt}`);
            if (details.stoppedAt) console.log(`执行器停止 · ${details.stoppedAt}`);
            if (details.filesChanged?.length) console.log(`工作区变更\n${details.filesChanged.join('\n')}`);
          }
          if (details.stopIssue) console.log(`停止进度 · ${details.stopIssue}`);
          if (details.diagnostic) console.log(`运行说明\n${details.diagnostic}`);
          if (details.failure && !repeatedFailure) console.log(failureHint(details.failure));
          if (details.blocker) console.log(`卡点\n${details.blocker}`);
          if (details.remaining) console.log(`待完成\n${details.remaining}`);
          for (const artifact of details.artifacts) console.log(`产物 · ${artifact.label} · ${artifact.location}`);
          console.log(`\n${response.title}${details.summary ? '\n' + details.summary : ''}`);
        } else if (agentId) {
          console.log(`Agent · ${agentLabel(agentId)}${task.model ? ' / ' + task.model : ''}`);
          console.log(reasoningLabel(task.reasoning_effort));
        }
        const descriptions = taskDescriptions(task, runs);
        console.log(`\n原始描述\n${descriptions.original}\n\n本轮描述\n${descriptions.current ?? '未记录'}`);
        if (actions.resume) console.log(`${actions.resume === 'session' ? '续跑原会话' : '以新会话继续'} · desk resume ${id} [说明]`);
        if (actions.retry) console.log(`${merge ? '核对并继续合并' : '重试（新会话）'} · desk retry ${id}`);
        if (merge?.repo && merge.pr) console.log(`  PR https://github.com/${merge.repo}/pull/${merge.pr}`);
        for (const r of runs) {
          console.log(`  Run #${r.id} · ${agentLabel(r.agent_id ?? task.agent_id)}${r.model ? ' / ' + r.model : ''} · ${reasoningLabel(r.reasoning_effort)} · ${r.kind === 'resume' ? '续跑' : '执行'} · ${runStage(r)}` +
            `${r.session_id ? ' session=' + r.session_id.slice(0, 8) : ''}`);
          if (r.checkpoint_sha) console.log(`    Git checkpoint ${r.checkpoint_sha}`);
          if (task.state !== 'running' && r.log_path) console.log(`    完整日志 · ${r.log_path}`);
        }
        if (merge?.completed) console.log(merge.completed);
        return;
      }
      const { tasks } = await api('GET', '/api/tasks');
      if (!tasks.length) { console.log('队列为空（desk run <project> "指令" 挂任务）'); return; }
      const { projects } = await api('GET', '/api/projects');
      const pname = new Map<number, string>(((projects as Project[]).map(p => [p.id, p.name])));
      for (const t of (tasks as TaskView[]).slice(0, 20)) {
        const status = taskStateLabel(t);
        console.log(`#${String(t.id).padEnd(4)} [${status.padEnd(8)}] ${pname.get(t.project_id)} · ${agentLabel(t.agent_id)}  ${t.prompt.slice(0, 50)}…`);
      }
      return;
    }
    case 'activity': {
      const id = rest[0]?.replace(/^#/, '');
      if (!id || !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) < 1) {
        throw new Error('用法: desk activity <任务编号>');
      }
      const result = await api('POST', `/api/tasks/${id}/actions`, { type: 'activity' });
      console.log(result.message.replace(/^### /, ''));
      return;
    }
    case 'resume': {
      const [id, ...fbParts] = rest;
      const feedback = fbParts.join(' ');
      if (!id) { console.log('用法: desk resume <taskId> ["你的反馈"]'); return; }
      const r = await api('POST', `/api/tasks/${id}/actions`, { type: 'resume', feedback });
      console.log(r.message.replaceAll('**', ''));
      return;
    }
    case 'retry': {
      const r = await api('POST', `/api/tasks/${rest[0]}/actions`, { type: 'retry' });
      console.log(r.message.replaceAll('**', ''));
      return;
    }
    case 'cancel': {
      const [id, runId] = rest;
      if (!id) throw new Error('用法: desk cancel <任务编号> [Run 编号]');
      const result = await api('POST', `/api/tasks/${id.replace(/^#/, '')}/actions`,
        { type: 'cancel', runId: runId === undefined ? undefined : Number(runId) });
      console.log(result.message.replaceAll('**', '').replaceAll('\x60', '')); return;
    }
    case 'notify-test': {
      const r = await api('POST', '/api/notify/test');
      for (const res of r.results) {
        console.log(res.ok ? `✅ ${res.channel} 通路正常` : `❌ ${res.channel}: ${res.error}`);
      }
      process.exit(r.results.every((x: any) => x.ok) ? 0 : 1);
    }
    case 'doctor': {
      const { runDoctor, printDoctor } = await import('../../daemon/src/doctor.js');
      const { values } = parseArgs({ args: rest, options: { isolation: { type: 'boolean' }, merge: { type: 'boolean' }, project: { type: 'string' }, json: { type: 'boolean' }, task: { type: 'string' }, run: { type: 'string' }, output: { type: 'string' }, agent: { type: 'string' } } });
      const { readRuntimeConfig } = await import('../../daemon/src/agent-settings.js');
      if (values.json || values.task || values.run || values.output) {
        const { diagnoseEnvironment, diagnoseStoredTask, diagnosticExport } = await import('../../daemon/src/diagnostics.js');
        const task = values.task ? Number(values.task.replace(/^#/, '')) : undefined;
        const run = values.run ? Number(values.run.replace(/^#/, '')) : undefined;
        if (task !== undefined && (!Number.isSafeInteger(task) || task < 1) || run !== undefined && (!task || !Number.isSafeInteger(run) || run < 1)) throw new Error('请提供有效的 --task 编号及可选 --run 编号');
        const report = task ? await diagnoseStoredTask(cfg, task, run) : await diagnoseEnvironment(cfg, values.agent,
          { mode: values.isolation ? 'isolation' : 'capability', merge: values.merge, projectPath: values.project });
        const json = diagnosticExport(report);
        if (values.output) {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(values.output, json, { flag: 'wx', mode: 0o600 });
          console.log(`诊断报告已导出：${values.output}`);
        } else console.log(values.json ? json : report.findings.map(item => `${item.level === 'error' ? '❌' : item.level === 'warning' ? '⚠️' : 'ℹ️'} ${item.title}\n${item.detail}\n${item.suggestions.join('\n')}`).join('\n\n'));
        process.exitCode = report.findings.some(item => item.level === 'error') ? 1 : 0;
        return;
      }
      const code = printDoctor(await runDoctor(readRuntimeConfig(cfg), { mode: values.isolation ? 'isolation' : 'capability', merge: values.merge, projectPath: values.project, agentId: values.agent }));
      process.exit(code);
    }
    case 'auth': {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true, options: { isolation: { type: 'boolean' }, 'device-auth': { type: 'boolean' } },
      });
      const agent_id = positionals[0] ?? 'codex';
      if (agent_id !== 'codex' || positionals.length > 1) throw new Error('目前支持 Codex 登录');
      if (!values.isolation) {
        const { readRuntimeConfig } = await import('../../daemon/src/agent-settings.js');
        const { findNativeAgent } = await import('../../daemon/src/agent-runtime.js');
        const codex = findNativeAgent('codex', readRuntimeConfig(cfg))?.command[0];
        if (!codex) throw new Error('找不到宿主 Codex，请先运行 desk doctor');
        process.exitCode = await loginHostCodex(codex, readRuntimeConfig(cfg).proxy, !!values['device-auth']);
        return;
      }
      const r = await api('POST', '/api/auth/login', { agent_id });
      console.log(`\n🔐 设备码登录（${agent_id}）：`);
      console.log(`   1. 打开 ${r.url}`);
      console.log(`   2. 输入码: ${S(r.code)}\n`);
      console.log('   浏览器完成授权后凭证自动写入卷，无需其他操作。');
      return;
    }
    default:
      console.log('Runember CLI —— 命令: start | stop | logs | doctor | auth | agents | proxy | project | draft | run | merge | status | activity | resume | retry | cancel | notify-test');
      console.log('  例: npm run desk -- doctor       # 环境自检');
      console.log('      npm run desk -- project add demo D:/work/demo');
      console.log('      npm run desk -- run demo "给 README 加一节安装说明"');
  }
}

main().catch(e => { console.error('CLI 异常:', e?.message ?? e); process.exit(1); });
