/** HTTP API 和钉钉共用的任务动作。 */
import { parseResultMarker, stripAgentctlLines } from '@agentdesk/core';
import type { FeedbackAction, RunSummary, Task, TaskStatus } from '@agentdesk/core';
import type { Store } from './store.js';
import type { Scheduler } from './scheduler.js';

const STATUS: Record<TaskStatus, string> = {
  draft: '📝 草稿', queued: '⏳ 排队', running: '▶️ 运行中', blocked: '⚠️ 阻塞',
  done: '✅ 已完成', failed: '❌ 失败', cancelled: '🚫 已取消',
};
const taskStatus = (task: Task) => task.status === 'done' && task.partial_remaining ? '🟡 部分完成' : STATUS[task.status];
const canResume = (task: Task, store: Store) => task.status === 'blocked' ||
  (task.status === 'done' && !!(task.partial_remaining || store.lastSessionOfTask(task.id)));

const HELP = [
  '### 🤖 agentdesk 指令',
  '- `状态 [编号]` / `status [编号]` · 看队列或单个任务',
  '- `项目` / `projects` · 查看可派单的项目',
  '- `执行 [项目] <描述>` / `run [项目] <描述>` · 派发新任务',
  '- `草稿 [项目] <描述>` / `draft [项目] <描述>` · 保存草稿',
  '- `执行 55` / `run 55` · 启动草稿',
  '- `继续 55 [说明]` / `resume 55 [说明]` · 继续阻塞任务或已有会话',
  '- `重试 55` / `retry 55` · 失败后重新执行',
  '- `取消 55` / `cancel 55` · 取消草稿、排队或阻塞任务',
  '- `帮助` / `help` · 显示指令',
  '',
  '只有一个项目时可以省略项目名。任务编号可以写 `55` 或 `#55`，也可以写 `55 继续` 或 `55 取消`。',
].join('  \n');

export async function applyTaskAction(
  store: Store,
  scheduler: Scheduler,
  action: FeedbackAction,
  origin: 'api' | 'dingtalk' = 'api',
): Promise<{ ok: boolean; message: string }> {
  const projectName = (id: number) => store.getProject(id)?.name ?? `项目#${id}`;
  const fail = (message: string) => ({ ok: false, message });
  const reply = (message: string) => ({ ok: true, message });
  const id = action.taskId;

  if (action.type === 'help') return reply(HELP);
  if (action.type === 'projects') {
    const projects = store.listProjects();
    if (!projects.length) return reply('尚未注册项目。');
    return reply([
      '### 📁 项目',
      ...projects.map(project => `- ${project.name}`),
      '',
      '派单示例 `执行 项目名 给登录接口加限流`',
    ].join('\n'));
  }

  if (action.type === 'status' || action.type === 'detail') {
    if (id === undefined) {
      const queued = store.listTasks('queued');
      const running = store.listTasks('running');
      const blocked = store.listTasks('blocked');
      const recent = store.listTasks().slice(0, 6);
      return reply([
        '### 📋 队列状态',
        `${STATUS.queued} ${queued.length} · ${STATUS.running} ${running.length} · ${STATUS.blocked} ${blocked.length}`,
        blocked.length ? '待处理 ' + blocked.map(t => `#${t.id}（${projectName(t.project_id)}）`).join('、') : '',
        recent.length ? [
          '**近期任务**',
          ...recent.map(t => `- **#${t.id}** ${projectName(t.project_id)} · ${taskStatus(t)}`),
        ].join('\n') : '',
        '用 `状态 55` 查看指定任务。',
      ].filter(Boolean).join('\n\n'));
    }
    const task = store.getTask(id);
    if (!task) return fail(`任务 #${id} 不存在。`);
    const run = store.runsOfTask(id).at(-1);
    let summary: RunSummary | undefined;
    if (run?.summary_json) {
      try { summary = JSON.parse(run.summary_json) as RunSummary; } catch { /* 旧运行记录可能无有效摘要 */ }
    }
    const rawSummary = summary?.agentMessage ?? '';
    const result = stripAgentctlLines(rawSummary).trim() || parseResultMarker(rawSummary)?.summary;
    const merge = store.getMerge(id);
    const reason = task.status === 'blocked' || task.status === 'failed' ? run?.blocked_kind : undefined;
    return reply([
      `### 📋 任务 #${id} · ${projectName(task.project_id)}`,
      `**${taskStatus(task)}**${reason ? ` · ${reason === 'verification_failed' ? '测试或验收未通过' : reason}` : ''}`,
      `**任务描述**\n\n${task.prompt}`,
      result ? `**最近一次运行**\n\n${result}` : '',
      task.partial_remaining ? `**未完成事项**\n\n${task.partial_remaining}` : '',
      merge?.state.repo && merge.state.pr ? `[查看 PR](https://github.com/${merge.state.repo}/pull/${merge.state.pr})` : '',
      !merge && canResume(task, store) ? `续跑 \`继续 ${id} [说明]\`` : '',
    ].filter(Boolean).join('\n\n'));
  }

  if (action.type === 'draft' || (action.type === 'run' && id === undefined)) {
    const draft = action.type === 'draft';
    const command = draft ? '草稿' : '执行';
    const projects = store.listProjects();
    if (!projects.length) return fail('尚未注册项目。');
    let prompt = action.prompt?.trim() ?? '';
    const firstWord = prompt.split(/\s+/)[0] ?? '';
    const namedProject = action.projectId === undefined ? store.findProject(firstWord) : undefined;
    if (namedProject) prompt = prompt.slice(firstWord.length).trim();
    const project = action.projectId !== undefined ? store.getProject(action.projectId)
      : namedProject ?? (projects.length === 1 ? projects[0] : undefined);
    if (!project) {
      return fail(`请指定项目 \`${command} <项目> <描述>\`。可用项目 ${projects.map(p => p.name).join('、')}。`);
    }
    if (!prompt) return fail(`请输入任务描述 \`${command} ${project.name} <描述>\`。`);
    const task = store.addTask(project.id, prompt, { draft });
    if (!draft) scheduler.tickNow();
    return reply([
      `### ${draft ? '📝 草稿已创建' : '⏳ 任务已入队'}`,
      `**#${task.id}** · ${project.name}`,
      prompt,
      draft ? `启动草稿 \`执行 ${task.id}\`` : `查看状态 \`状态 ${task.id}\``,
    ].join('\n\n'));
  }

  if (id === undefined || !Number.isSafeInteger(id) || id <= 0) {
    return fail('请填写任务编号，例如 `继续 55`。');
  }
  const task = store.getTask(id);
  if (!task) return fail(`任务 #${id} 不存在。`);
  const merge = store.getMerge(id);
  const resumable = canResume(task, store);
  const title = `**#${id} · ${projectName(task.project_id)}**`;

  switch (action.type) {
    case 'run': {
      if (merge) return fail('自动化合并任务通过 CLI 管理。');
      if (task.status !== 'draft') {
        return fail(resumable ? `请用 \`继续 ${id}\` 续跑此任务。`
          : `任务 #${id} 当前为${STATUS[task.status]}。只有草稿可以用「执行 <编号>」启动。`);
      }
      const extra = action.prompt?.trim();
      if (extra && extra !== task.prompt) store.updateTaskPrompt(id, task.prompt + '\n' + extra);
      store.setTaskStatus(id, 'queued');
      scheduler.tickNow();
      return reply(`⏳ 草稿 ${title} 已入队。查看 \`状态 ${id}\`。`);
    }
    case 'resume': {
      if (merge) return fail('自动化合并任务请通过 CLI retry 继续。');
      if (!resumable) return fail(`任务 #${id} 当前为${STATUS[task.status]}，无法续跑。`);
      const feedback = action.feedback?.trim() || (task.partial_remaining ? '请继续完成剩余部分' : '请继续');
      store.setPendingFeedback(id, feedback);
      store.setTaskStatus(id, 'queued');
      scheduler.tickNow();
      return reply(`⏳ 任务 ${title} 已安排继续。\n\n${feedback}`);
    }
    case 'retry': {
      if (merge && origin === 'dingtalk') return fail('自动化合并任务请通过 CLI retry 继续。');
      if (origin === 'dingtalk' ? task.status !== 'failed' : !['failed', 'blocked', 'done'].includes(task.status)) {
        return fail(resumable ? `请用 \`继续 ${id}\` 续跑此任务。`
          : `任务 #${id} 当前为${STATUS[task.status]}，无法重试。`);
      }
      store.setPendingFeedback(id, null);
      if (merge) store.deferMerge(id, 0);
      store.setTaskStatus(id, 'queued');
      scheduler.tickNow();
      return reply(`⏳ 任务 ${title} 已重新入队。${merge ? '将核对并继续已有合并进度。' : '将从原指令重新执行。'}`);
    }
    case 'cancel': {
      if (merge && origin === 'dingtalk') return fail('自动化合并任务请通过 CLI cancel 取消。');
      if (task.status === 'running') return fail(`任务 #${id} 正在运行，暂不支持在线取消。`);
      if (origin === 'dingtalk' && !['draft', 'queued', 'blocked'].includes(task.status)) {
        return fail(`任务 #${id} 当前为${STATUS[task.status]}，无法取消。`);
      }
      store.setTaskStatus(id, 'cancelled');
      return reply(`🚫 任务 ${title} 已取消。`);
    }
    default:
      return fail('无法识别该任务动作，发送 `帮助` 查看指令。');
  }
}
