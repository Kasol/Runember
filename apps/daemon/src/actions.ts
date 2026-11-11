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
  if (action.type === 'status') {
    const all = store.listTasks();
    const blocked = store.listTasks('blocked');
    const running = all.filter(t => t.status === 'running');
    const recent = all.filter(t => !['running'].includes(t.status)).slice(0, 6);

    let md = br('### 📋 agentdesk 队列');
    if (blocked.length) {
      md += br() + br(`**⚠️ 等你决定（${blocked.length}）**`);
      for (const t of blocked) md += br(`- **#${t.id}** ${cut(t.prompt, 36)}`);
      md += br('> 回复 `resume <决定>` 即可续跑');
    }
    if (running.length) {
      md += br() + br(`**🔄 执行中（${running.length}）**`);
      for (const t of running) md += br(`- **#${t.id}** ${cut(t.prompt, 36)}`);
    }
    md += br() + br('**最近任务**');
    for (const t of recent) md += br(`- ${badge(t.status)} **#${t.id}** ${cut(t.prompt, 30)}`);
    if (!all.length) md += br('队列为空，`run <项目> "任务"` 挂一个吧');
    return { ok: true, message: md };
  }

  if (action.type === 'run') {
    // 手机派单：run [项目名] <描述>；项目省略时——仅注册了一个项目则用它，多个则列清单
    // prompt 首词若恰好是已注册项目名则视为项目名（如 "run selftest 修bug"），否则整句是描述
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
        cmd('run <项目> <任务描述>', '派发新任务（项目名可省，默认唯一注册项目）') +
        cmd('resume [编号] <决定>', '阻塞任务带决定续跑（仅一个阻塞任务时可省编号）') +
        cmd('retry <编号>', '重新执行该任务') +
        cmd('cancel <编号>', '取消任务') +
        cmd('status', '查看队列与执行进度') +
        br() +
        br('💡 中英文指令均可（派任务/继续/重试/取消/状态）。' +
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
          for (const t of blocked) md += br(`- **#${t.id}** ${cut(t.prompt, 30)} → \`resume ${t.id} <决定>\``);
          return { ok: false, message: md };
        }
        rid = blocked[0]!.id;
        task = blocked[0]!;
      }
      if (!task) return { ok: false, message: `任务 #${rid} 不存在` };
      if (task.status !== 'blocked') {
        return {
          ok: false,
          message: br(`${badge(task.status)} **#${rid}** 当前不是阻塞状态，无法 resume`) +
            br() +
            (task.status === 'done' ? br(`想重跑可回复 \`retry ${rid}\``) : ''),
        };
      }
      store.setPendingFeedback(rid, action.feedback ?? '请继续');
      store.setTaskStatus(rid, 'queued');
      scheduler.tickNow();
      return {
        ok: true,
        message: br(`### ✅ #${rid} 已带决定续跑`) +
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
      return { ok: true, message: br(`### 🔁 #${id} 已重新入队`) + br() + br('将作为全新执行开始。') };
    }
    case 'cancel': {
      if (!task) return { ok: false, message: `任务 #${id} 不存在` };
      if (task.status === 'running') return { ok: false, message: `#${id} 正在运行，暂不支持在线取消（M2）` };
      store.setTaskStatus(id, 'cancelled');
      return { ok: true, message: br(`### 🚫 #${id} 已取消`) };
    }
  }
}
