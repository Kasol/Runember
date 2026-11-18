import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotifyEvent, Project, Task } from '@agentdesk/core';
import { buildEventMarkdown } from '../src/dingtalk-markdown.js';
import { DedupedNotifier } from '../src/notify-base.js';

const project: Project = { id: 1, name: 'selftest', workspace_path: '', agent_id: 'codex', created_at: '' };
const task: Task = { id: 55, project_id: 1, prompt: '原始任务内容'.repeat(50), status: 'done', created_at: '' };

test('DingTalk completion notification bounds the preview and leaves full data in details', () => {
  const table = '| 日期 | 气温 |\n|---|---|\n| 周一 | 13–19℃ |\n| 周日 | 8–16℃ |';
  const agentMessage = '天气预报。'.repeat(70) + '\n\n' + table;
  const filesChanged = Array.from({ length: 7 }, (_, i) => `file-${i}.txt`);
  const diffStat = filesChanged.map(name => `${name} | 1 +`).join('\n');
  const remaining = '未完成的内容。'.repeat(50);
  const markdown = buildEventMarkdown({
    kind: 'run.succeeded', runId: 1, task, project, summary: { agentMessage, filesChanged, diffStat, partial: true, remaining },
    details: { id: 1, agentId: 'codex', stage: '正常退出', exitCode: 0, summary: agentMessage, remaining, artifacts: [] },
    actions: { resume: 'session', retry: false, cancel: false },
  }, '')!.text;
  assert.match(markdown, /### ⏹ 已结束/);
  assert.doesNotMatch(markdown, /\*\*卡点\*\*/);
  assert.match(markdown, /待完成 ·/);
  assert.ok(markdown.length < 1100);
  assert.ok(!markdown.includes(agentMessage));
  assert.ok(!markdown.includes(diffStat));
  assert.match(markdown, /…/);
  assert.match(markdown, /继续 55/);
});

test('DingTalk start and failure notifications bound previews', () => {
  const reason = '运行失败的原因。'.repeat(50);
  assert.ok(!buildEventMarkdown({ kind: 'run.started', runId: 1, task, project }, '')!.text.includes(task.prompt));
  assert.ok(!buildEventMarkdown({ kind: 'run.failed', runId: 1, task, project, reason }, '')!.text.includes(reason));
});

test('a new run can report the same blocker and failed delivery can be retried', async () => {
  const sent: number[] = [];
  let fail = true;
  const channel = new class extends DedupedNotifier {
    readonly name = 'fixture';
    protected async send(event: NotifyEvent) {
      if (fail) throw new Error('delivery failed');
      sent.push(event.runId);
    }
  }();
  const first = { kind: 'run.blocked', runId: 5, task, project, blockedKind: 'git_in_progress', question: 'Git 操作进行中' } as const;
  await assert.rejects(channel.notify(first), /delivery failed/);
  fail = false;
  await Promise.all([channel.notify(first), channel.notify(first)]);
  await channel.notify({ ...first, runId: 6 });
  assert.deepEqual(sent, [5, 6]);
  const text = buildEventMarkdown(first, '')!.text;
  assert.match(text, /### ⏹ 已结束/);
  assert.match(text, /卡点 · Git 操作进行中/);
  assert.doesNotMatch(text, /\*\*待完成\*\*/);
});

test('DingTalk puts the explicit question above the run facts', () => {
  const markdown = buildEventMarkdown({
    kind: 'run.blocked', runId: 2, task, project, blockedKind: 'approval_needed',
    details: { id: 2, stage: '正常退出', exitCode: 0, confirmation: '是否授权？', summary: '此前的答复', artifacts: [] },
    actions: { resume: 'session', retry: false, cancel: true },
  }, 'https://agentdesk.example');
  assert.equal(markdown.title, '🟡 等待确认');
  assert.ok(markdown.text.indexOf('是否授权？') < markdown.text.indexOf('Run #2'));
  assert.match(markdown.text, /续跑原会话 `继续 55/);
});

test('English notifications translate scheduler labels and offer only the continue command', () => {
  const markdown = buildEventMarkdown({
    kind: 'run.failed', runId: 3, task, project, reason: '原始 Agent 答复',
    details: { id: 3, stage: '正常退出', exitCode: 0, artifacts: [], summary: '原始 Agent 答复' },
    actions: { resume: false, retry: true, cancel: false },
  }, '', undefined, 'en');
  assert.equal(markdown.title, '⏹ Ended');
  assert.match(markdown.text, /Normal exit · Exit code 0/);
  assert.match(markdown.text, /Agent response/);
  assert.match(markdown.text, /continue 55/);
  assert.doesNotMatch(markdown.text, /retry 55|已结束|退出码|重试|继续|\*\*Agent 答复\*\*/);
  assert.ok(markdown.text.includes('原始 Agent 答复'));
});
