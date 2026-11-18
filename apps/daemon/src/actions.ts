/** HTTP API 和钉钉共用的任务动作。 */
import { describeActivity, runDetails, taskStateLabel, taskView } from '@agentdesk/core';
import type { FeedbackAction, RunActivity, Task, TaskActions, UiLanguage } from '@agentdesk/core';
import type { Store } from './store.js';
import type { Scheduler } from './scheduler.js';
import { runDetailsMarkdown } from './dingtalk-markdown.js';

export function availableTaskActions(store: Store, task: Task, origin: 'api' | 'dingtalk' = 'api'): TaskActions {
  const status = task.status;
  const merge = !!store.getMerge(task.id);
  const pending = status === 'blocked' || (status === 'done' && !!task.partial_remaining);
  const hasSession = !merge && !!store.lastSessionOfTask(task.id);
  const active = ['running', 'blocked', 'cancelled'].includes(status) ? store.latestRun(task.id) : undefined;
  const cancelledRun = status === 'cancelled' && active?.status === 'cancelled';
  return {
    resume: !merge && (pending || ((['done', 'failed'].includes(status) || cancelledRun) && hasSession)
      || (origin === 'dingtalk' && (['done', 'failed'].includes(status) || cancelledRun)))
      ? (hasSession ? 'session' : 'new_session') : false,
    retry: origin === 'dingtalk' ? !merge && (status === 'failed' || cancelledRun)
      : ['failed', 'blocked', 'done'].includes(status) || cancelledRun,
    cancel: (origin === 'api' || !merge) && (
      status === 'draft' || status === 'queued' || taskView(task, active).state === 'awaiting_confirmation'
      || (status === 'running' && !merge && !!active && !active.execution)
    ),
  };
}

const HELP_ZH = [
  '### 🤖 agentdesk 指令',
  '- `项目` · 查看可派单的项目',
  '- `开始 [项目] <描述>` / `开始 编号` · 派发任务或启动草稿',
  '- `状态 [编号]` · 看队列，带编号时附最近 10 条活动',
  '- `继续 55 [说明]` · 继续任务，有会话时恢复原会话',
  '- `取消 55` · 取消任务，运行中的执行器停止后结算',
  '- `帮助` · 显示指令',
  '',
  '只有一个项目时可以省略项目名。任务编号可以写 `55` 或 `#55`，也可以写 `55 继续` 或 `55 取消`。',
].join('  \n');

const HELP_EN = [
  '### 🤖 agentdesk commands',
  '- `projects` · List available projects',
  '- `start [project] <description>` / `start <number>` · Create a task or start a draft',
  '- `status [number]` · Show the queue or one task with its last 10 activities',
  '- `continue 55 [feedback]` · Continue a task using its existing session when available',
  '- `cancel 55` · Cancel a task, settling after its executor stops',
  '- `help` · Show commands',
  '',
  'With one project, its name is optional. Use either 55 or #55 for a task number.',
].join('  \n');

export function formatActivity(activities: RunActivity[], language: UiLanguage = 'zh-CN'): string {
  const last = activities.at(-1);
  if (!last) return language === 'en' ? 'No Agent activity has been recorded for this run.' : '这轮暂无已记录的 Agent 活动。';
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(last.at)) / 1000));
  const age = seconds === 0 ? '刚刚'
    : seconds >= 86400 ? `${Math.floor(seconds / 86400)} 天前`
    : seconds >= 3600 ? `${Math.floor(seconds / 3600)} 小时前`
    : seconds >= 60 ? `${Math.floor(seconds / 60)} 分钟前` : `${seconds} 秒前`;
  const englishAge = seconds === 0 ? 'just now' : seconds < 60 ? `${seconds}s ago`
    : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago`
    : seconds < 86400 ? `${Math.floor(seconds / 3600)}h ago` : `${Math.floor(seconds / 86400)}d ago`;
  const clock = new Intl.DateTimeFormat(language, { timeStyle: 'medium', hour12: false });
  const lines = activities.map(item => {
    return `- ${clock.format(new Date(item.at))} · ${describeActivity(item, language).replace(/\s+/g, ' ')}`;
  });
  return [language === 'en' ? `Last activity: ${englishAge}` : `最近一次活动：${age}`, '', ...lines].join('\n');
}

export async function applyTaskAction(
  store: Store,
  scheduler: Scheduler,
  action: FeedbackAction,
  origin: 'api' | 'dingtalk' = 'api',
): Promise<{ ok: boolean; message: string }> {
  const language = origin === 'dingtalk' ? action.language ?? 'zh-CN' : 'zh-CN';
  const t = (zh: string, en: string) => language === 'en' ? en : zh;
  const startCommand = t('开始', 'start');
  const continueCommand = t('继续', 'continue');
  const statusCommand = t('状态', 'status');
  const cancelCommand = t('取消', 'cancel');
  const stateLabel = (task: Parameters<typeof taskStateLabel>[0]) => taskStateLabel(task, language);
  const projectName = (id: number) => store.getProject(id)?.name ?? t(`项目#${id}`, `Project #${id}`);
  const fail = (message: string) => ({ ok: false, message });
  const reply = (message: string) => ({ ok: true, message });
  const id = action.taskId;

  if (origin === 'dingtalk' && action.type === 'retry') action = { ...action, type: 'resume' };
  if (origin === 'dingtalk' && action.type === 'draft') return fail(t(
    '请在看板保存草稿，再用「开始 编号」启动。', 'Save drafts in the dashboard, then use “start <number>”.'));
  if (action.type === 'help') return reply(language === 'en' ? HELP_EN : HELP_ZH);
  if (action.type === 'projects') {
    const projects = store.listProjects();
    if (!projects.length) return reply(t('尚未注册项目。', 'No projects have been registered.'));
    return reply([
      t('### 📁 项目', '### 📁 Projects'),
      ...projects.map(project => `- ${project.name} · ${project.agent_id}${project.model ? ' / ' + project.model : ''}`),
      '',
      t('派单示例 `开始 项目名 给登录接口加限流`', 'Example: `start project-name Add rate limiting to the login endpoint`'),
    ].join('\n'));
  }

  if (action.type === 'activity') {
    if (id === undefined || !Number.isSafeInteger(id) || id <= 0) return fail(t('请填写任务编号，例如 `状态 55`。', 'Enter a task number, for example `status 55`.'));
    const task = store.getTask(id);
    if (!task) return fail(t(`任务 #${id} 不存在。`, `Task #${id} does not exist.`));
    const run = store.latestRun(id);
    const view = taskView(task, run);
    return reply([
      t(`### 任务 #${id} · 最近活动`, `### Task #${id} · Recent activity`),
      run ? t(`最近一轮 Run #${run.id} · ${stateLabel(view)}`, `Latest Run #${run.id} · ${stateLabel(view)}`) : stateLabel(view),
      run ? formatActivity(store.recentRunActivities(run.id), language) : t('任务还没有运行记录。', 'This task has not run yet.'),
    ].join('\n\n'));
  }

  if (action.type === 'status' || action.type === 'detail') {
    if (id === undefined) {
      const queued = store.listTasks('queued');
      const running = store.listTaskViews('running');
      const tasks = store.listTaskViews();
      const awaiting = store.listTaskViews('blocked').filter(task => task.state === 'awaiting_confirmation');
      const recent = tasks.slice(0, 6);
      return reply([
        t('### 📋 队列状态', '### 📋 Task queue'),
        `${stateLabel({ state: 'queued' })} ${queued.length} · ${stateLabel({ state: 'running' })} ${running.length} · ${stateLabel({ state: 'awaiting_confirmation' })} ${awaiting.length}`,
        running.some(task => task.stopping) ? t(`正在停止 ${running.filter(task => task.stopping).length}`, `Stopping ${running.filter(task => task.stopping).length}`) : '',
        awaiting.length ? t('待处理 ', 'Needs input ') + awaiting.map(task => `#${task.id} (${projectName(task.project_id)})`).join(', ') : '',
        recent.length ? [
          t('**近期任务**', '**Recent tasks**'),
          ...recent.map(task => `- **#${task.id}** ${projectName(task.project_id)} · ${stateLabel(task)} · ${task.agent_id ?? 'codex'}`),
        ].join('\n') : '',
        t('用 `状态 55` 查看指定任务。', 'Use `status 55` to inspect a task.'),
      ].filter(Boolean).join('\n\n'));
    }
    const task = store.getTask(id);
    if (!task) return fail(t(`任务 #${id} 不存在。`, `Task #${id} does not exist.`));
    const run = store.latestRun(id);
    const view = taskView(task, run);
    const details = run && runDetails(run, task.agent_id ?? 'codex', task.partial_remaining);
    const merge = store.getMerge(id);
    const actions = availableTaskActions(store, task, origin);
    return reply([
      t(`### 📋 任务 #${id} · ${projectName(task.project_id)}`, `### 📋 Task #${id} · ${projectName(task.project_id)}`),
      `**${stateLabel(view)}**`,
      !run ? `Agent · ${task.agent_id ?? 'codex'}${task.model ? ' / ' + task.model : ''}` : '',
      details ? runDetailsMarkdown(details, view.state === 'awaiting_confirmation', language) : '',
      origin === 'dingtalk' && run ? [
        t('**最近活动（最多 10 条）**', '**Recent activity (up to 10)**'),
        formatActivity(store.recentRunActivities(run.id), language),
      ].join('\n\n') : '',
      `**${t('任务描述', 'Task description')}**\n\n${task.prompt}`,
      merge?.state.repo && merge.state.pr ? `[${t('查看 PR', 'View PR')}](https://github.com/${merge.state.repo}/pull/${merge.state.pr})` : '',
      actions.resume ? `${actions.resume === 'session' ? t('续跑原会话', 'Resume the session') : t('以新会话继续', 'Continue in a new session')} \`${continueCommand} ${id} [${t('说明', 'feedback')}]\`` : '',
      origin !== 'dingtalk' && actions.retry && !merge ? `重试（新会话） \`重试 ${id}\`` : '',
      actions.cancel && view.state === 'running' && !view.stopping ? `${t('停止任务', 'Stop the task')} \`${cancelCommand} ${id}\`` : '',
      run?.log_path ? `**${t('完整日志', 'Full log')}**\n\n${run.log_path}` : '',
    ].filter(Boolean).join('\n\n'));
  }

  if (action.type === 'draft' || (action.type === 'run' && id === undefined)) {
    const draft = action.type === 'draft';
    const command = draft ? '草稿' : startCommand;
    const projects = store.listProjects();
    if (!projects.length) return fail(t('尚未注册项目。', 'No projects have been registered.'));
    let prompt = action.prompt?.trim() ?? '';
    const firstWord = prompt.split(/\s+/)[0] ?? '';
    const namedProject = action.projectId === undefined ? store.findProject(action.projectName ?? firstWord) : undefined;
    if (namedProject && action.projectName === undefined) prompt = prompt.slice(firstWord.length).trim();
    const project = action.projectId !== undefined ? store.getProject(action.projectId)
      : namedProject ?? (action.projectName === undefined && projects.length === 1 ? projects[0] : undefined);
    if (!project) {
      return fail(t(`请指定项目 \`${command} <项目> <描述>\`。可用项目 ${projects.map(p => p.name).join('、')}。`,
        `Choose a project: \`start <project> <description>\`. Available projects: ${projects.map(p => p.name).join(', ')}.`));
    }
    if (!prompt) return fail(t(`请输入任务描述 \`${command} ${project.name} <描述>\`。`,
      `Enter a description: \`start ${project.name} <description>\`.`));
    const task = store.addTask(project.id, prompt, { draft });
    if (!draft) scheduler.tickNow();
    return reply([
      `### ${draft ? '📝 草稿已创建' : t('⏳ 任务已入队', '⏳ Task queued')}`,
      `**#${task.id}** · ${project.name}`,
      `Agent · ${task.agent_id}${task.model ? ' / ' + task.model : ''}`,
      prompt,
      draft ? `启动草稿 \`开始 ${task.id}\`` : `${t('查看状态', 'Check status')} \`${statusCommand} ${task.id}\``,
    ].join('\n\n'));
  }

  if (id === undefined || !Number.isSafeInteger(id) || id <= 0) {
    return fail(t('请填写任务编号，例如 `继续 55`。', 'Enter a task number, for example `continue 55`.'));
  }
  const task = store.getTask(id);
  if (!task) return fail(t(`任务 #${id} 不存在。`, `Task #${id} does not exist.`));
  const merge = store.getMerge(id);
  const actions = availableTaskActions(store, task, origin);
  const latest = store.latestRun(id);
  const statusLabel = stateLabel(taskView(task, latest));
  const title = `**#${id} · ${projectName(task.project_id)}**`;

  switch (action.type) {
    case 'run': {
      if (merge) return fail(t('自动化合并任务通过 CLI 管理。', 'Manage merge tasks using the CLI.'));
      if (task.status !== 'draft') {
        return fail(actions.resume ? t(`请用 \`继续 ${id}\` 继续此任务。`, `Use \`continue ${id}\` to continue this task.`)
          : t(`任务 #${id} 当前为${statusLabel}。只有草稿可以用「开始 <编号>」启动。`,
            `Task #${id} is ${statusLabel}. Use “start <number>” for drafts.`));
      }
      const extra = action.prompt?.trim();
      if (extra && extra !== task.prompt) store.updateTaskPrompt(id, task.prompt + '\n' + extra);
      store.setTaskStatus(id, 'queued');
      scheduler.tickNow();
      return reply(t(`⏳ 草稿 ${title} 已入队。查看 \`状态 ${id}\`。`, `⏳ Draft ${title} queued. Use \`status ${id}\`.`));
    }
    case 'resume': {
      if (merge) return fail(t('自动化合并任务请通过 CLI retry 继续。', 'Continue merge tasks with CLI retry.'));
      if (!actions.resume) return fail(t(`任务 #${id} 当前为${statusLabel}，无法续跑。`, `Task #${id} is ${statusLabel} and cannot be continued.`));
      const feedback = action.feedback?.trim() || (task.partial_remaining ? t('请继续完成剩余部分', 'Please continue with the remaining work') : t('请继续', 'Please continue'));
      store.setPendingFeedback(id, feedback);
      store.setTaskStatus(id, 'queued');
      scheduler.tickNow();
      return reply(t(`⏳ 任务 ${title} 已入队，将${actions.resume === 'session' ? '恢复原会话' : '以新会话继续'}。\n\n${feedback}`,
        `⏳ Task ${title} queued. ${actions.resume === 'session' ? 'The previous session will resume.' : 'A new session will start.'}\n\n${feedback}`));
    }
    case 'retry': {
      if (merge && origin === 'dingtalk') return fail('自动化合并任务请通过 CLI retry 继续。');
      if (!actions.retry) {
        return fail(actions.resume ? `请用 \`继续 ${id}\` 继续此任务。`
          : `任务 #${id} 当前为${statusLabel}，无法重试。`);
      }
      store.setPendingFeedback(id, null);
      if (merge) store.deferMerge(id, 0);
      store.setTaskStatus(id, 'queued');
      scheduler.tickNow();
      return reply(`⏳ 任务 ${title} 已重新入队。${merge ? '将核对并继续已有合并进度。' : '将从原指令重新执行。'}`);
    }
    case 'cancel': {
      if (merge && origin === 'dingtalk') return fail(t('自动化合并任务请通过 CLI cancel 取消。', 'Cancel merge tasks with CLI cancel.'));
      if (action.runId !== undefined && (latest?.id !== action.runId
          || (task.status !== 'running' && !(task.status === 'cancelled' && latest?.status === 'cancelled')))) {
        return fail(t(`Run #${action.runId} 已结束或已被新一轮替代，请刷新任务状态。`, `Run #${action.runId} has ended or been replaced. Refresh the task status.`));
      }
      if (task.status === 'cancelled') return reply(t(`🚫 任务 ${title} 已取消。`, `🚫 Task ${title} cancelled.`));
      if (task.status === 'running' && merge) return fail('自动化合并正在执行当前流程，请在其回到队列后取消。');
      if (task.status === 'running') {
        const target = store.requestCancellation(id, action.runId);
        if (!target) return fail(t(`任务 #${id} 正在结算实际退出结果。请刷新任务状态。`, `Task #${id} is settling its exit result. Refresh its status.`));
        scheduler.stopRun(target);
        return reply(t(`▶️ 任务 ${title} · Run #${target.id} · 正在停止。查看 \`状态 ${id}\`。`,
          `▶️ Task ${title} · Run #${target.id} · Stopping. Use \`status ${id}\`.`));
      }
      if (!actions.cancel) {
        return fail(t(`任务 #${id} 当前为${statusLabel}，无法取消。`, `Task #${id} is ${statusLabel} and cannot be cancelled.`));
      }
      store.setTaskStatus(id, 'cancelled');
      return reply(t(`🚫 任务 ${title} 已取消。`, `🚫 Task ${title} cancelled.`));
    }
    default:
      return fail(t('无法识别该任务动作，发送 `帮助` 查看指令。', 'Unknown action. Send `help` to see commands.'));
  }
}
