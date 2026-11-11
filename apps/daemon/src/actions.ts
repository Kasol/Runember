/**
 * 任务动作的统一入口 —— HTTP API、钉钉 Stream、未来 GUI 全走这里。
 * 保证任何入口对任务状态机的操作语义完全一致。
 */
import type { FeedbackAction } from '@agentdesk/core';
import type { Store } from './store.js';
import type { Scheduler } from './scheduler.js';

export async function applyTaskAction(
  store: Store,
  scheduler: Scheduler,
  action: FeedbackAction,
): Promise<{ ok: boolean; message: string }> {
  if (action.type === 'status') {
    const blocked = store.listTasks('blocked');
    const recent = store.listTasks().slice(0, 5);
    const lines = ['📋 阻塞中：' + (blocked.length ? '' : '无')];
    for (const t of blocked) lines.push(`  ⚠️ #${t.id} ${t.prompt.slice(0, 40)}…`);
    lines.push('最近任务：');
    for (const t of recent) lines.push(`  #${t.id} [${t.status}] ${t.prompt.slice(0, 30)}…`);
    return { ok: true, message: lines.join('\n') };
  }

  if (action.type === 'help') {
    return {
      ok: true,
      message: [
        '🤖 指令：',
        '  resume <id> <决定>  / 继续 <id> <决定> —— 阻塞任务带反馈续跑',
        '  retry <id>   / 重试 <id>',
        '  cancel <id>  / 取消 <id>',
        '  status       / 状态 —— 查看队列',
      ].join('\n'),
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
          return {
            ok: false,
            message: '当前有多个阻塞任务，请带编号：\n' +
              blocked.map(t => `  resume ${t.id} <决定> —— ${t.prompt.slice(0, 30)}…`).join('\n'),
          };
        }
        rid = blocked[0]!.id;
        task = blocked[0]!;
      }
      if (!task) return { ok: false, message: `任务 #${rid} 不存在` };
      if (task.status !== 'blocked') {
        return { ok: false, message: `#${rid} 当前 ${task.status}，仅 blocked 可 resume（已完成可用 retry ${rid} 重跑）` };
      }
      store.setPendingFeedback(rid, action.feedback ?? '请继续');
      store.setTaskStatus(rid, 'queued');
      scheduler.tickNow();
      return { ok: true, message: `✅ #${rid} 已带反馈入队续跑` };
    }
    case 'retry': {
      if (!task) return { ok: false, message: `任务 #${id} 不存在` };
      if (!['failed', 'blocked', 'done'].includes(task.status)) return { ok: false, message: `#${id} 当前 ${task.status}，不可重试` };
      store.setPendingFeedback(id, null);
      store.setTaskStatus(id, 'queued');
      scheduler.tickNow();
      return { ok: true, message: `✅ #${id} 已重新入队` };
    }
    case 'cancel': {
      if (!task) return { ok: false, message: `任务 #${id} 不存在` };
      if (task.status === 'running') return { ok: false, message: `#${id} 正在运行，暂不支持在线取消（M2）` };
      store.setTaskStatus(id, 'cancelled');
      return { ok: true, message: `🚫 #${id} 已取消` };
    }
  }
}
