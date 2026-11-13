/**
 * 钉钉消息模板（共享）：webhook 机器人与应用机器人两腿使用完全相同的文案。
 * 修改通知样式只需改这一个文件。
 */
import type { NotifyEvent } from '@agentdesk/core';
import { stripAgentctlLines } from '@agentdesk/core';

const LINE = '  \n';   // 钉钉 markdown 换行
const HR = '  \n---\n'; // 分隔线

export function buildEventMarkdown(
  e: NotifyEvent,
  publicUrl: string,
): { title: string; text: string } | null {
  const t = `**#${e.task.id}** ${e.project.name}`;
  const detailLink = publicUrl
    ? `${LINE}[🎯 打开任务详情（看板）](${publicUrl}/?task=${e.task.id})`
    : `${LINE}> 提示：配置 server.publicUrl 后可从这里直达看板详情`;

  if (e.kind === 'run.blocked') {
    return {
      title: '⚠️ agentdesk 任务阻塞',
      text: [
        '### ⚠️ 任务阻塞 · 需要你的决定',
        LINE + `**${t}** \`${e.blockedKind}\``,
        HR,
        e.question ? `**❓ ${e.question}**` : '（详见任务日志）',
        HR,
        `**📱 手机直接回复**（回答问题本身）：${LINE}\`resume ${e.task.id} 你的决定\``,
        LINE + `或在群里 @机器人：\`resume ${e.task.id} 同意暂缓验收\``,
        detailLink,
      ].join(''),
    };
  }
  if (e.kind === 'run.failed') {
    return {
      title: '❌ agentdesk 任务失败',
      text: [
        '### ❌ 任务失败',
        LINE + `**${t}**`,
        HR,
        `**原因**：${e.reason.slice(0, 180)}`,
        HR,
        `**重试**：回复 \`retry ${e.task.id}\`${publicUrl ? ` · [看板详情](${publicUrl}/?task=${e.task.id})` : ''}`,
      ].join(''),
    };
  }
  if (e.kind === 'run.succeeded') {
    const s = e.summary;
    const partial = s.partial === true;
    return {
      title: partial ? '⚠️ agentdesk 任务部分完成' : '✅ agentdesk 任务完成',
      text: [
        partial ? '### ⚠️ 任务部分完成（agent 自报未做完）' : '### ✅ 任务完成',
        LINE + `**${t}**`,
        HR,
        s.agentMessage ? `**📝 agent 总结**${LINE}> ${stripAgentctlLines(s.agentMessage).replace(/\n/g, LINE + '> ').slice(0, 260) || '(见未完成部分)'}` : '',
        LINE,
        s.filesChanged.length
          ? `**🗂 改动 ${s.filesChanged.length} 个文件**${LINE}${s.filesChanged.slice(0, 5).map(f => `- \`${f}\``).join(LINE)}${s.filesChanged.length > 5 ? LINE + '- …' : ''}`
          : '🗂 无文件改动',
        s.diffStat ? LINE + `\`${s.diffStat.replace(/\n/g, ' · ').slice(0, 120)}\`` : '',
        partial && s.remaining
          ? HR + `**📋 未完成部分**（可派后续任务）：${LINE}> ${s.remaining.slice(0, 200)}` +
            LINE + `回复 \`draft ${e.project.name} 继续完成：${s.remaining.slice(0, 40)}\``
          : '',
        detailLink,
      ].join(''),
    };
  }
  // run.started
  return {
    title: '▶️ agentdesk 任务开始',
    text: [
      '### ▶️ 任务开始',
      LINE + `**${t}**`,
      LINE + `> ${e.task.prompt.slice(0, 120)}`,
      detailLink,
    ].join(''),
  };
}
