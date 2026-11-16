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
    const gitPaused = e.blockedKind === 'git_in_progress';
    return {
      title: '⚠️ agentdesk 任务阻塞',
      text: [
        gitPaused ? '### ⚠️ 任务暂停 · Git 操作待继续' : '### ⚠️ 任务阻塞 · 需要你的决定',
        LINE + `**${t}** \`${e.blockedKind}\``,
        HR,
        e.question ? `**❓ ${e.question}**` : '（详见任务日志）',
        HR,
        e.retryViaCli ? `处理后在宿主机运行 \`npm run desk -- retry ${e.task.id}\`。`
          : `在群里 @机器人并回复 \`继续 ${e.task.id} 你的决定\`。${gitPaused ? ` 查看详情用 \`状态 ${e.task.id}\`。` : ''}`,
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
        `**原因**：${e.reason}`,
        HR,
        (e.retryViaCli ? `在宿主机运行 \`npm run desk -- retry ${e.task.id}\`` : `回复 \`重试 ${e.task.id}\``) +
          (publicUrl ? ` · [看板详情](${publicUrl}/?task=${e.task.id})` : ''),
      ].join(''),
    };
  }
  if (e.kind === 'run.succeeded') {
    const s = e.summary;
    const partial = s.partial === true;
    const summary = s.agentMessage && stripAgentctlLines(s.agentMessage);
    return {
      title: partial ? '🟡 agentdesk 任务部分完成' : '✅ agentdesk 任务完成',
      text: [
        partial ? '### 🟡 任务部分完成（agent 自报未做完）' : '### ✅ 任务完成',
        t,
        '---',
        summary ? `**📝 agent 总结**\n\n${summary}` : '',
        s.filesChanged.length
          ? `**🗂 改动 ${s.filesChanged.length} 个文件**\n\n${s.filesChanged.map(f => `- \`${f}\``).join('\n')}`
          : '🗂 无文件改动',
        s.diffStat ? `\`\`\`\n${s.diffStat}\n\`\`\`` : '',
        partial && s.remaining
          ? `---\n\n**📋 未完成部分**\n\n${s.remaining}\n\n回复 \`继续 ${e.task.id}\` 可以续跑此任务。`
          : '',
        detailLink.trimStart(),
      ].filter(Boolean).join('\n\n'),
    };
  }
  // run.started
  return {
    title: '▶️ agentdesk 任务开始',
    text: [
      '### ▶️ 任务开始',
      LINE + `**${t}**`,
      `\n\n${e.task.prompt}\n`,
      detailLink,
    ].join(''),
  };
}
