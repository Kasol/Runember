/**
 * 任务动作的统一入口 —— HTTP API、钉钉 Stream、未来 GUI 全走这里。
 * 保证任何入口对任务状态机的操作语义完全一致。
 *
 * message 约定：钉钉 markdown 子集（不支持 HTML）。换行必须
 * "行尾两空格 + \n"（钉钉渲染换行的唯一可靠方式），统一走 md() 构造。
 */
import type { FeedbackAction } from '@agentdesk/core';
import type { Store } from './store.js';
import type { Scheduler } from './scheduler.js';

/** 钉钉 markdown 换行：行尾两空格 + \n */
const br = (line = '') => line + '  \n';

/** 状态徽章：给任务状态一个一眼可读的样式 */
function badge(status: string): string {
  const map: Record<string, string> = {
    queued: '🕐 排队', running: '🔄 运行中', blocked: '⚠️ 阻塞',
    done: '✅ 完成', failed: '❌ 失败', cancelled: '🚫 取消',
  };
  return map[status] ?? status;
}

/** 截断一行文本 */
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/** 解析 "run [项目名] 描述" —— 项目名不含空格；首词若匹配已注册项目名则为项目 */
function parseRunCommand(
  raw: string,
  store: Store,
): { type: 'run'; projectId?: number; prompt: string } | null {
  const s = raw.trim().replace(/^@\S+\s*/, '');
  const m = s.match(/^(?:run|派任务|执行)\s+(.+)$/i);
  if (!m) return null;
  const rest = m[1]!.trim();
  const firstSpace = rest.indexOf(' ');
  if (firstSpace < 0) return { type: 'run', prompt: rest }; // 只有描述，无项目词
  const maybeProject = rest.slice(0, firstSpace);
  const project = store.findProject(maybeProject);
  if (project) return { type: 'run', projectId: project.id, prompt: rest.slice(firstSpace + 1).trim() };
  return { type: 'run', prompt: rest };
}

export async function applyTaskAction(
  store: Store,
  scheduler: Scheduler,
  action: FeedbackAction,
): Promise<{ ok: boolean; message: string }> {
  /** 项目名速查（多项目并行时每条消息必须可辨识归属） */
  const projectName = (id: number) => store.getProject(id)?.name ?? `项目#${id}`;

  if (action.type === 'status') {
    // 摘要卡片：钉钉群聊气泡对 markdown 渲染有 ~12 行折叠限制，超长必截断。
    // 所以 status 只给 ≤8 行的计数摘要；完整列表走「详情」指令按需拉取。
    const all = store.listTasks();
    const blocked = store.listTasks('blocked');
    const running = all.filter(t => t.status === 'running');
    const done = all.filter(t => t.status === 'done').length;

    let md = br('### 📋 agentdesk 队列');
    if (blocked.length) {
      // 多项目：阻塞行带项目名（如 "#16(web-cad)"），批复时可精准定位
      md += br(`⚠️ **阻塞 ${blocked.length}**：` +
        blocked.map(t => `#${t.id}(${projectName(t.project_id)})`).join('、'));
    }
    md += br(`🔄 ${running.length ? '进行中 ' + running.length : '空闲'}` +
      (done ? ` · 已完成 ${done}` : ''));
    if (blocked.length) md += br('> 回复 `resume <id> <决定>` 续跑 · `详情` 看完整列表');
    return { ok: true, message: md };
  }

  if (action.type === 'projects') {
    const all = store.listProjects();
    if (!all.length) return { ok: true, message: br('📭 尚未注册任何项目') + br() + br('机器上：`desk project add <名> <路径>`') };
    let md = br(`### 📁 项目（${all.length}）`);
    for (const p of all) {
      md += br(`- **${p.name}** \`${p.workspace_path}\`${p.agent_id !== 'codex' ? ' · agent: ' + p.agent_id : ''}`);
    }
    md += br() + br('> 派任务：`run <项目名> <描述>`');
    return { ok: true, message: md };
  }

  if (action.type === 'detail') {
    // 详情列表：两行式（编号行 + 描述行）。实测钉钉手机一行约可容纳 24-26 个
    // 中文字符（#15 的 20 字完整显示），故描述限 40 字——绝大多数完整，超长才截。
    const all = store.listTasks().slice(0, 6);
    let md = br('### 📋 任务列表（最新 6 条）');
    for (const t of all) {
      md += br() + br(`${badge(t.status)} **#${t.id}** \`${projectName(t.project_id)}\``);
      md += br(`　${cut(t.prompt, 40)}`);
    }
    md += br() + br('> `resume <id> <决定>` / `retry <id>` / `cancel <id>` · 更多任务上 Web 看板');
    return { ok: true, message: md };
  }

  if (action.type === 'draft') {
    // 建草稿（不执行）：draft [项目名] <描述>；Web/钉钉均以 draft 为唯一创建入口
    const all = store.listProjects();
    if (!all.length) return { ok: false, message: '尚未注册任何项目（先在机器上 desk project add）' };
    let projectId = action.projectId;
    let prompt = action.prompt ?? '';
    if (all.length > 1 && !projectId) {
      const firstWord = prompt.split(/\s+/)[0] ?? '';
      const hit = store.findProject(firstWord);
      if (hit) {
        projectId = hit.id;
        prompt = prompt.slice(firstWord.length).trim();
      }
    }
    if (!projectId && all.length === 1) projectId = all[0]!.id;
    if (!projectId) {
      return {
        ok: false,
        message: br('**有多个项目，请带项目名：**') + br() +
          all.map(p => br(`- \`draft ${p.name} <描述>\``)).join(''),
      };
    }
    const project = store.getProject(projectId);
    if (!project) return { ok: false, message: '项目不存在' };
    if (!prompt.trim()) return { ok: false, message: '任务描述不能为空：`draft <项目> <描述>`' };
    const t = store.addTask(project.id, prompt, { draft: true });
    return {
      ok: true,
      message: br('### 📝 草稿已创建') +
        br() +
        br(`**#${t.id}** → 项目 \`${project.name}\``) +
        br(cut(prompt, 60)) +
        br() +
        br(`执行：\`run ${t.id}\`（Web 草稿队列也可编辑后再执行）`),
    };
  }

  if (action.type === 'run') {
    // run = 执行动作（不创建）：三种形态
    //   run <数字>            执行草稿/已存在任务 #数字（可 resume blocked、可入队 draft）
    //   run <数字> <补充文字>   同上，并把补充文字合入任务描述
    //   run [项目名] <描述>    全新任务，直接入队执行
    const all = store.listProjects();
    const raw = action.prompt ?? '';
    let projectId = action.projectId;
    let prompt = raw;
    let refId: number | undefined;

    // 形态判定：首 token 是纯数字 → 任务引用
    const numMatch = raw.match(/^#?(\d+)\s*([\s\S]*)$/);
    if (numMatch) {
      refId = Number(numMatch[1]);
      prompt = numMatch[2]!.trim();
    } else if (all.length > 1) {
      const firstWord = raw.split(/\s+/)[0] ?? '';
      const hit = store.findProject(firstWord);
      if (hit) {
        projectId = hit.id;
        prompt = raw.slice(firstWord.length).trim();
      }
    }
    if (!projectId && all.length === 1) projectId = all[0]!.id;

    // ── 形态一：引用已有任务（草稿执行 / blocked resume / 其他状态提示）──
    if (refId !== undefined) {
      const t = store.getTask(refId);
      if (!t) return { ok: false, message: `任务 #${refId} 不存在` };

      // 补充文字合入描述（草稿完善 / 给 blocked 任务追加信息）
      if (prompt && t.prompt !== prompt) {
        store.updateTaskPrompt(refId, t.prompt + (t.prompt ? '\n' : '') + prompt);
      }

      if (t.status === 'draft') {
        store.setTaskStatus(refId, 'queued');
        scheduler.tickNow();
        return {
          ok: true,
          message: br(`### ▶️ 草稿 #${refId} 已入队执行`) +
            br() +
            br(`项目 \`${projectName(t.project_id)}\``) +
            br(cut(prompt ? t.prompt + '\n+ ' + prompt : t.prompt, 80)) +
            br() +
            br('调度器将在数秒内拾取。'),
        };
      }
      if (t.status === 'blocked') {
        store.setPendingFeedback(refId, prompt || '请继续');
        store.setTaskStatus(refId, 'queued');
        scheduler.tickNow();
        return { ok: true, message: br(`### ✅ #${refId}(${projectName(t.project_id)}) 已带信息重新入队`) };
      }
      return { ok: false, message: `#${refId} 当前 ${t.status}（仅 draft 可执行、blocked 可续跑；想重跑用 \`retry ${refId}\`）` };
    }

    // ── 形态二：全新任务直接入队 ──
    if (!all.length) return { ok: false, message: '尚未注册任何项目（先在机器上 desk project add）' };
    if (!projectId) {
      return {
        ok: false,
        message: br('**有多个项目，请带项目名：**') + br() +
          all.map(p => br(`- \`run ${p.name} <描述>\``)).join(''),
      };
    }
    const project = store.getProject(projectId);
    if (!project) return { ok: false, message: '项目不存在' };
    if (!prompt.trim()) return { ok: false, message: '任务描述不能为空：`run <项目> <描述>`' };
    const newTask = store.addTask(project.id, prompt);
    scheduler.tickNow();
    return {
      ok: true,
      message: br('### 📋 任务已入队') +
        br() +
        br(`**#${newTask.id}** → 项目 \`${project.name}\``) +
        br(cut(prompt, 60)) +
        br() +
        br('调度器将在数秒内拾取执行。'),
    };
  }

  if (action.type === 'help') {
    const cmd = (c: string, desc: string) => br(`- \`${c}\` — ${desc}`);
    return {
      ok: true,
      message:
        br('### 🤖 agentdesk 指令') +
        br() +
        cmd('draft [项目] <描述>', '创建草稿（不会执行；Web 草稿队列也可创建/编辑）') +
        cmd('run <编号>', '执行草稿/续跑阻塞任务（可附补充文字合入描述）') +
        cmd('run [项目] <描述>', '全新任务直接入队执行') +
        cmd('resume [编号] <决定>', '阻塞任务带决定续跑（仅一个阻塞任务时可省编号）') +
        cmd('retry <编号>', '重新执行该任务') +
        cmd('cancel <编号>', '取消任务') +
        cmd('status', '队列摘要') +
        cmd('详情', '完整任务列表（含所属项目）') +
        cmd('项目', '所有已注册项目') +
        br() +
        br('💡 编号即归属：任务编号绑定其项目，`status`/`详情` 的每行都会显示所属项目，' +
           '多项目并行时按编号操作即可精准定位。中英文均可（派任务/继续/重试/取消/状态）。' +
           '示例：`run myproj 给登录接口加限流`'),
    };
  }

  const id = action.taskId ?? -1;
  let task = store.getTask(id);
  if (!task && action.type !== 'resume') return { ok: false, message: `任务 #${id ?? '?'} 不存在` };

  switch (action.type) {
    case 'resume': {
      // 免编号：未指定 id 时指向唯一阻塞任务（v1 串行模式下常态）
      let rid = action.taskId;
      if (!rid) {
        const blocked = store.listTasks('blocked');
        if (blocked.length === 0) return { ok: false, message: '当前没有阻塞任务（发 status 查看队列）' };
        if (blocked.length > 1) {
          let md = br('**当前有多个阻塞任务，请带编号：**') + br();
          for (const t of blocked) {
            md += br(`- **#${t.id}**(${projectName(t.project_id)}) ${cut(t.prompt, 30)} → \`resume ${t.id} <决定>\``);
          }
          return { ok: false, message: md };
        }
        rid = blocked[0]!.id;
        task = blocked[0]!;
      }
      if (!task) return { ok: false, message: `任务 #${rid} 不存在` };
      if (task.status !== 'blocked') {
        return {
          ok: false,
          message: br(`🚫 **#${rid}** 当前 ${badge(task.status)}，无法执行`) +
            br() +
            (task.status === 'done' || task.status === 'failed'
              ? br(`想重跑可回复 \`retry ${rid}\``)
              : task.status === 'cancelled'
                ? br('已取消的任务如需重跑：`retry ' + rid + '`')
                : ''),
        };
      }
      store.setPendingFeedback(rid, action.feedback ?? '请继续');
      store.setTaskStatus(rid, 'queued');
      scheduler.tickNow();
      return {
        ok: true,
        message: br(`### ✅ #${rid}(${projectName(task.project_id)}) 已带决定续跑`) +
          br() +
          br(`> ${cut(action.feedback ?? '请继续', 60)}`) +
          br('同一会话上下文，调度器将在数秒内拾取。'),
      };
    }
    case 'retry': {
      if (!task) return { ok: false, message: `任务 #${id} 不存在` };
      if (!['failed', 'blocked', 'done'].includes(task.status)) return { ok: false, message: `#${id} 当前 ${task.status}，不可重试` };
      store.setPendingFeedback(id, null);
      store.setTaskStatus(id, 'queued');
      scheduler.tickNow();
      return { ok: true, message: br(`### 🔁 #${id}(${projectName(task.project_id)}) 已重新入队`) + br() + br('将作为全新执行开始。') };
    }
    case 'cancel': {
      if (!task) return { ok: false, message: `任务 #${id} 不存在` };
      if (task.status === 'running') return { ok: false, message: `#${id} 正在运行，暂不支持在线取消（M2）` };
      store.setTaskStatus(id, 'cancelled');
      return { ok: true, message: br(`### 🚫 #${id}(${projectName(task.project_id)}) 已取消`) };
    }
  }
}
