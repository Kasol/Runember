/**
 * 钉钉查询和通知共用的运行详情文案。
 */
import { runTiming, stripAgentctlLines, taskStateLabel, failureHint, type NotifyEvent, type RunDetails, type UiLanguage } from '@agentdesk/core';

export function runDetailsMarkdown(details: RunDetails, showConfirmation: boolean, language: UiLanguage = 'zh-CN'): string {
  const t = (zh: string, en: string) => language === 'en' ? en : zh;
  return [
    showConfirmation && details.confirmation ? `**${t('等待确认', 'Confirmation needed')}**\n\n${details.confirmation}` : '',
    runTiming(details, language),
    details.network ? `${t('启动时 HTTPS 代理', 'HTTPS proxy at launch')} · ${details.network.httpsProxy || t('未指定', 'Unspecified')}` : '',
    details.connection?.state === 'retrying' ? `**${details.stage === '连接重试中' ? t('连接重试中', 'Reconnecting') : t('停止前的连接重试', 'Connection retries before exit')}** · ${t(details.connection.reason, 'The Agent reported connection errors.')}\n\n${t('开始重连', 'Retrying since')}：${details.connection.since}\n\n${t('最后有效活动', 'Last meaningful progress')}：${details.connection.lastProgressAt}` : '',
    details.cancellationRequestedAt ? `**${t('请求取消', 'Cancellation requested')}** · ${details.cancellationRequestedAt}` : '',
    details.cancellationRequestedAt && details.stoppedAt ? `**${t('执行器停止', 'Executor stopped')}** · ${details.stoppedAt}` : '',
    details.stopIssue ? `**${t('停止进度', 'Stopping progress')}**\n\n${details.stopIssue}` : '',
    details.diagnostic ? `**${t('运行说明', 'Run diagnostic')}**\n\n${details.diagnostic}` : '',
    details.failure ? `**${t('处理建议', 'Suggested action')}**\n\n${failureHint(details.failure, language === 'en')}` : '',
    details.blocker ? `**${t('卡点', 'Blocker')}**\n\n${details.blocker}` : '',
    details.remaining ? `**${t('待完成', 'Remaining work')}**\n\n${details.remaining}` : '',
    details.artifacts.length ? [`**${t('产物', 'Artifacts')}**`, ...details.artifacts.map(artifact => {
      const label = artifact.label.replace(/[\[\]\r\n]/g, ' ');
      return artifact.href ? `- [${label}](<${artifact.href}>)` : `- ${label} · ${artifact.location}`;
    })].join('\n') : '',
    details.summary ? `**${t('Agent 答复', 'Agent response')}**\n\n${details.summary}` : '',
    details.cancellationRequestedAt && details.filesChanged?.length
      ? [`**${t('工作区变更', 'Workspace changes')}**`, ...details.filesChanged.map(file => `- \`${file}\``)].join('\n') : '',
  ].filter(Boolean).join('\n\n');
}

function excerpt(text: string | undefined, limit: number): string {
  const plain = (text ?? '').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(plain);
  return chars.length > limit ? chars.slice(0, limit).join('') + '…' : plain;
}

export function detailFooter(text: string, detailUrl?: string, language: UiLanguage = 'zh-CN'): string {
  return detailUrl ? `${text}\n\n---\n\n[📄 ${language === 'en' ? 'View details' : '查看详情'}](${detailUrl})` : text;
}

export function buildEventMarkdown(e: NotifyEvent, publicUrl: string, reportUrl?: string, language: UiLanguage = 'zh-CN', reportFailed = false): { title: string; text: string; detailUrl?: string } {
  const t = (zh: string, en: string) => language === 'en' ? en : zh;
  const task = `**#${e.task.id}** ${e.project.name} · ${e.task.agent_id ?? e.project.agent_id}${e.task.model ? ' / ' + e.task.model : ''}`;
  const detailLink = !reportUrl && !publicUrl ? t('完整答复和日志可在 Runember 任务详情查看。', 'View the full response and log in Runember.') : '';

  if (e.kind === 'run.started') {
    const title = taskStateLabel({ state: 'running' }, language);
    return { title, text: [`### ${title}`, task, `Run #${e.runId} · ${e.project.agent_id} · ${t('准备执行', 'Preparing')}`, excerpt(e.task.prompt, 180), detailLink].join('\n\n') };
  }
  if (e.kind === 'run.connection_warning' || e.kind === 'run.connection_recovered') {
    const recovered = e.kind === 'run.connection_recovered';
    const title = recovered ? t('▶️ Agent 已恢复活动', '▶️ Agent activity resumed') : t('⚠️ 连接重试中', '⚠️ Reconnecting');
    return { title, text: [`### ${title}`, task, `Run #${e.runId}`, recovered ? t('已观察到 Agent 恢复有效活动，任务继续执行。', 'Meaningful Agent activity has resumed; the run continues.')
      : t('持续连接重试超过 2 分钟，期间未观察到新的有效活动。执行器仍在运行。', 'Connection retries have lasted over 2 minutes without meaningful progress. The executor is still running.'),
      t(e.connection.reason, 'The Agent reported connection errors.'), `${t('最后有效活动', 'Last meaningful progress')} · ${e.connection.lastProgressAt}`,
      recovered ? '' : t('请检查环境设置中的代理和连接。不会自动新开任务；可查看状态或主动取消。', 'Check the proxy and connection in Environment settings. No new run is started automatically; inspect status or cancel if needed.')].filter(Boolean).join('\n\n') };
  }
  const summary = 'summary' in e ? e.summary : undefined;
  const details: RunDetails = e.details ?? {
    id: e.runId, agentId: e.project.agent_id,
    stage: e.kind === 'run.failed' ? t('执行异常', 'Execution error') : t('已停止', 'Stopped'),
    blocker: e.kind === 'run.blocked' ? e.question : undefined,
    summary: e.kind === 'run.failed' ? e.reason : stripAgentctlLines(summary?.agentMessage ?? ''),
    remaining: summary?.remaining,
    artifacts: [],
  };
  const waiting = !!details.confirmation;
  const title = taskStateLabel({ state: e.kind === 'run.cancelled' ? 'cancelled' : waiting ? 'awaiting_confirmation' : 'ended' }, language);
  const retryViaCli = 'retryViaCli' in e && e.retryViaCli;
  const next = retryViaCli ? t(`在宿主机运行 \`desk retry ${e.task.id}\` 核对并继续。`, `Run \`desk retry ${e.task.id}\` on the host to check and continue.`)
    : e.actions?.resume || e.actions?.retry
      ? `${e.actions?.resume === 'session' ? t('续跑原会话', 'Resume the session') : t('以新会话继续', 'Continue in a new session')} \`${t('继续', 'continue')} ${e.task.id} [${t('说明', 'feedback')}]\`` : '';
  return {
    title,
    detailUrl: reportUrl ?? (publicUrl ? `${publicUrl}/?task=${e.task.id}` : undefined),
    text: [
      `### ${title}`,
      task,
      waiting && details.confirmation ? `**${t('等待确认', 'Confirmation needed')}**\n\n${excerpt(details.confirmation, 360)}` : '',
      runTiming(details, language),
      details.stopIssue || details.diagnostic ? `${t('运行说明', 'Run diagnostic')} · ${excerpt(details.stopIssue || details.diagnostic, 140)}` : '',
      e.repeatedFailure ? t(`💡 连续 ${e.repeatedFailure.count} 轮出现同类故障。${e.repeatedFailure.hint}`, `💡 ${e.repeatedFailure.count} consecutive runs encountered the same failure. Consider checking the connection or account.`) : '',
      !e.repeatedFailure && details.failure ? failureHint(details.failure, language === 'en') : '',
      details.blocker ? `${t('卡点', 'Blocker')} · ${excerpt(details.blocker, 140)}` : '',
      details.remaining ? `${t('待完成', 'Remaining work')} · ${excerpt(details.remaining, 140)}` : '',
      details.summary ? `**${t('Agent 答复', 'Agent response')}**\n\n${excerpt(details.summary, 220)}` : '',
      reportFailed ? t('⚠️ 详情报告暂未生成，请在 Runember 查看完整内容。', '⚠️ Detail report unavailable; view full details in Runember.') : '',
      next,
      detailLink,
    ].filter(Boolean).join('\n\n'),
  };
}
