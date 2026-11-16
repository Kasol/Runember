/**
 * agentdesk CLI（desk）—— daemon 的命令行驾驶舱。
 * 用法: npm run desk -- <command>
 *   project add <name> <绝对路径> [--agent codex]
 *   run <projectName> "任务指令"
 *   status [taskId]
 *   resume <taskId> "反馈"
 *   retry <taskId> / cancel <taskId>
 *   auth [codex]
 */
import type { Task, Project, Run } from '@agentdesk/core';
import { stripAgentctlLines } from '@agentdesk/core';
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, loadLocalEnv } from '../../daemon/src/config.js';
import { findHostCodex, loginHostCodex } from '../../daemon/src/native.js';
import { localAddress, startDaemon, stopDaemon } from './launcher.js';

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
  loadLocalEnv();
  const cfg = loadConfig({ port: process.env.AGENTDESK_PORT ? Number(process.env.AGENTDESK_PORT) : undefined });
  BASE = localAddress(cfg);
  TOKEN = process.env.AGENTDESK_TOKEN ?? cfg.server.token;
  const [cmd, ...rest] = process.argv.slice(2);

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
      const [sub, name, path, agentFlag] = rest;
      if (sub === 'list') {
        const { projects } = await api('GET', '/api/projects') as { projects: Project[] };
        for (const p of projects) console.log(`#${p.id} ${p.name} [${p.execution ?? 'capability'}] ${p.workspace_path}`);
        return;
      }
      if (sub !== 'add' || !name || !path) {
        console.log('用法: desk project list | project add <名称> <绝对路径> [--agent codex]');
        return;
      }
      const agent_id = agentFlag === '--agent' ? rest[3] ?? 'codex' : 'codex';
      const { project } = await api('POST', '/api/projects', { name, workspace_path: path, agent_id });
      console.log(`✅ 项目已注册 #${project.id} ${project.name} → ${project.workspace_path} (agent: ${project.agent_id})`);
      return;
    }
    case 'draft': {
      const [sub, idOrProject, ...text] = rest;
      if (sub === 'list') {
        const { drafts } = await api('GET', '/api/drafts') as { drafts: Task[] };
        for (const draft of drafts) console.log(`#${draft.id} ${draft.prompt}`);
        return;
      }
      const prompt = text.join(' ').trim();
      if (sub === 'add' && idOrProject && prompt) {
        const { task } = await api('POST', '/api/tasks', { project: idOrProject, prompt, draft: true });
        console.log(`草稿 #${task.id} 已保存。`);
        return;
      }
      if (idOrProject && /^#?\d+$/.test(idOrProject) && ((sub === 'edit' && prompt) || sub === 'run')) {
        const id = Number(idOrProject.replace(/^#/, ''));
        await api('POST', `/api/tasks/${id}/draft`, sub === 'edit' ? { op: 'edit', prompt } : { op: 'enqueue' });
        console.log(`草稿 #${id} ${sub === 'edit' ? '已更新' : '已入队'}。`);
        return;
      }
      throw new Error('用法: desk draft list | draft add <项目> <描述> | draft edit <编号> <描述> | draft run <编号>');
    }
    case 'run': {
      const [project, ...promptParts] = rest;
      const prompt = promptParts.join(' ');
      if (!project || !prompt) { console.log('用法: desk run <projectName> "任务指令"'); return; }
      const { task } = await api('POST', '/api/tasks', { project, prompt });
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
    case 'status': {
      const id = rest[0] ? Number(rest[0].replace(/^#/, '')) : undefined;
      if (rest[0] && (!id || !Number.isSafeInteger(id) || id < 1)) throw new Error('请输入有效任务编号');
      if (id) {
        const { task, runs, merge } = await api('GET', `/api/tasks/${id}`) as {
          task: Task; runs: Run[]; merge?: { repo?: string; pr?: number; completed?: string };
        };
        console.log(`任务#${task.id} [${task.status}]  ${task.prompt.slice(0, 60)}…`);
        if (merge?.repo && merge.pr) console.log(`  PR https://github.com/${merge.repo}/pull/${merge.pr}`);
        for (const r of runs) {
          console.log(`  run#${r.id} ${r.kind} [${r.status}]${r.blocked_kind ? ' blocked=' + r.blocked_kind : ''}` +
            `${r.session_id ? ' session=' + r.session_id.slice(0, 8) : ''}`);
          if (r.checkpoint_sha) console.log(`    Git checkpoint ${r.checkpoint_sha}`);
          if (r.summary_json) {
            const s = JSON.parse(r.summary_json);
            if (s.partial) console.log(`    ⚠️ 部分完成 — 未完成: ${String(s.remaining || '（未给出）').slice(0, 80)}`);
            if (s.agentMessage) console.log(`    💬 ${stripAgentctlLines(String(s.agentMessage)).replace(/\n/g, ' ').slice(0, 120)}`);
            if (s.filesChanged?.length) console.log(`    📝 改动 ${s.filesChanged.length} 个文件: ${s.filesChanged.slice(0, 5).join(', ')}${s.filesChanged.length > 5 ? ' …' : ''}`);
          }
        }
        const last = runs.at(-1);
        if (merge?.completed) console.log(merge.completed);
        if (last) console.log(`\n日志: ${last.log_path}`);
        return;
      }
      const { tasks } = await api('GET', '/api/tasks');
      if (!tasks.length) { console.log('队列为空（desk run <project> "指令" 挂任务）'); return; }
      const { projects } = await api('GET', '/api/projects');
      const pname = new Map<number, string>(((projects as Project[]).map(p => [p.id, p.name])));
      for (const t of (tasks as Task[]).slice(0, 20)) {
        console.log(`#${String(t.id).padEnd(4)} [${t.status.padEnd(8)}] ${pname.get(t.project_id)}  ${t.prompt.slice(0, 50)}…`);
      }
      return;
    }
    case 'resume': {
      const [id, ...fbParts] = rest;
      const feedback = fbParts.join(' ');
      if (!id) { console.log('用法: desk resume <taskId> ["你的反馈"]'); return; }
      const r = await api('POST', `/api/tasks/${id}/actions`, { type: 'resume', feedback });
      console.log(`🔁 已带反馈重新入队（run kind=resume）`);
      void r;
      return;
    }
    case 'retry': {
      const r = await api('POST', `/api/tasks/${rest[0]}/actions`, { type: 'retry' });
      console.log('↻ 已重新入队'); void r;
      return;
    }
    case 'cancel': {
      await api('POST', `/api/tasks/${rest[0]}/actions`, { type: 'cancel' });
      console.log('🚫 已取消'); return;
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
      const { values } = parseArgs({ args: rest, options: { isolation: { type: 'boolean' }, merge: { type: 'boolean' }, project: { type: 'string' } } });
      const code = printDoctor(await runDoctor(cfg, { mode: values.isolation ? 'isolation' : 'capability', merge: values.merge, projectPath: values.project }));
      process.exit(code);
    }
    case 'auth': {
      const { values, positionals } = parseArgs({
        args: rest, allowPositionals: true, options: { isolation: { type: 'boolean' }, 'device-auth': { type: 'boolean' } },
      });
      const agent_id = positionals[0] ?? 'codex';
      if (agent_id !== 'codex' || positionals.length > 1) throw new Error('目前支持 Codex 登录');
      if (!values.isolation) {
        const codex = findHostCodex();
        if (!codex) throw new Error('找不到宿主 Codex，请先运行 desk doctor');
        process.exitCode = await loginHostCodex(codex, cfg.proxy, !!values['device-auth']);
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
      console.log('agentdesk CLI —— 命令: start | stop | logs | doctor | auth | project | draft | run | merge | status | resume | retry | cancel | notify-test');
      console.log('  例: npm run desk -- doctor       # 环境自检');
      console.log('      npm run desk -- project add demo D:/work/demo');
      console.log('      npm run desk -- run demo "给 README 加一节安装说明"');
  }
}

main().catch(e => { console.error('CLI 异常:', e?.message ?? e); process.exit(1); });
