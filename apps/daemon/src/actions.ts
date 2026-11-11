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

  if (action.type === 'help') {
    const cmd = (c: string, desc: string) => br(`- \`${c}\` — ${desc}`);
    return {
      ok: true,
      message:
        br('### 🤖 agentdesk 指令') +
        br() +
        cmd('resume [编号] <决定>', '阻塞任务带决定续跑（仅一个阻塞任务时可省编号）') +
        cmd('retry <编号>', '重新执行该任务') +
        cmd('cancel <编号>', '取消任务') +
        cmd('status', '查看队列与执行进度') +
        br() +
        br('💡 中英文指令均可（继续/重试/取消/状态）。' +
           '任务阻塞时直接回复决定即可，例：`resume 可以上线，注意回滚`'),
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
