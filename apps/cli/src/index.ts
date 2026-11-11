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

const BASE = `http://127.0.0.1:${process.env.AGENTDESK_PORT ?? 8787}`;
const TOKEN = process.env.AGENTDESK_TOKEN ?? '';

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(TOKEN ? { 'x-agentdesk-token': TOKEN } : {}) },
    body: body ? JSON.stringify(body) : undefined,
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

  switch (cmd) {
    case 'project': {
      const [sub, name, path, agentFlag] = rest;
      if (sub !== 'add' || !name || !path) {
        console.log('用法: desk project add <name> <绝对路径> [--agent codex]');
        return;
      }
      const agent_id = agentFlag === '--agent' ? rest[3] ?? 'codex' : 'codex';
      const { project } = await api('POST', '/api/projects', { name, workspace_path: path, agent_id });
      console.log(`✅ 项目已注册 #${project.id} ${project.name} → ${project.workspace_path} (agent: ${project.agent_id})`);
      return;
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
    case 'status': {
      const id = rest[0] ? Number(rest[0]) : undefined;
      if (id) {
        const { task, runs } = await api('GET', `/api/tasks/${id}`) as { task: Task; runs: Run[] };
        console.log(`任务#${task.id} [${task.status}]  ${task.prompt.slice(0, 60)}…`);
        for (const r of runs) {
          console.log(`  run#${r.id} ${r.kind} [${r.status}]${r.blocked_kind ? ' blocked=' + r.blocked_kind : ''}` +
            `${r.session_id ? ' session=' + r.session_id.slice(0, 8) : ''}`);
          if (r.summary_json) {
            const s = JSON.parse(r.summary_json);
            if (s.agentMessage) console.log(`    💬 ${String(s.agentMessage).replace(/\n/g, ' ').slice(0, 120)}`);
            if (s.filesChanged?.length) console.log(`    📝 改动 ${s.filesChanged.length} 个文件: ${s.filesChanged.slice(0, 5).join(', ')}${s.filesChanged.length > 5 ? ' …' : ''}`);
          }
        }
        const last = runs.at(-1);
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
      if (!id || !feedback) { console.log('用法: desk resume <taskId> "你的反馈"'); return; }
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
    case 'auth': {
      const agent_id = rest[0] ?? 'codex';
      const r = await api('POST', '/api/auth/login', { agent_id });
      console.log(`\n🔐 设备码登录（${agent_id}）：`);
      console.log(`   1. 打开 ${r.url}`);
      console.log(`   2. 输入码: ${S(r.code)}\n`);
      console.log('   浏览器完成授权后凭证自动写入卷，无需其他操作。');
      return;
    }
    default:
      console.log('agentdesk CLI —— 命令: project add | run | status | resume | retry | cancel | auth');
      console.log('  例: npm run desk -- project add demo D:/work/demo');
      console.log('      npm run desk -- run demo "给 README 加一节安装说明"');
  }
}

main().catch(e => { console.error('CLI 异常:', e?.message ?? e); process.exit(1); });
