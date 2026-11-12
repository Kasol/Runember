/**
 * 钉钉消息模板（共享）：webhook 机器人与应用机器人两腿使用完全相同的文案。
 * 修改通知样式只需改这一个文件。
 */
import type { NotifyEvent } from '@agentdesk/core';

export function buildEventMarkdown(
  e: NotifyEvent,
  publicUrl: string,
): { title: string; text: string } | null {
  const t = `**任务#${e.task.id}** · 项目 \`${e.project.name}\``;

  if (e.kind === 'run.blocked') {
    return {
      title: '⚠️ agentdesk 任务阻塞',
      text: [
        '### ⚠️ agentdesk 任务阻塞',
        '',
        `${t} · \`${e.blockedKind}\``,
        '',
        e.question ? `> ${e.question}` : '> （详见任务日志）',
        '',
        '**💡 有效回复示例**（回答 agent 的问题本身，而非"继续"）：',
        '',
        '- 缺工具/依赖 → `resume 依赖已装好，继续`',
        '- 需要授权降级 → `resume 同意暂缓验收，先完成后端`',
        '- 不想做了 → `cancel ' + e.task.id + '`',
        publicUrl ? `\n[打开任务详情](${publicUrl}/tasks/${e.task.id})` : '',
      ].join('\n'),
    };
  }
  if (e.kind === 'run.failed') {
    return {
      title: '❌ agentdesk 任务失败',
      text: [
        '### ❌ agentdesk 任务失败',
        '',
        `${t}`,
        '',
        `> ${e.reason.slice(0, 200)}`,
        '',
        '```',
        `retry ${e.task.id}`,
        '```',
      ].join('\n'),
    };
  }
  if (e.kind === 'run.succeeded') {
    return {
      title: '✅ agentdesk 任务完成',
      text: [
        '### ✅ agentdesk 任务完成',
        '',
        `${t}`,
        '',
        e.summary.agentMessage ? `> ${e.summary.agentMessage.replace(/\n/g, ' ').slice(0, 200)}` : '',
        '',
        e.summary.filesChanged.length
          ? `📝 改动 ${e.summary.filesChanged.length} 个文件`
          : '📝 无文件改动',
      ].join('\n'),
    };
  }
  // run.started
  return { title: '▶️ agentdesk 任务开始', text: `### ▶️ 任务开始\n\n${t}` };
}
