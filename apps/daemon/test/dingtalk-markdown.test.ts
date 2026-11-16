import assert from 'node:assert/strict';
import test from 'node:test';
import type { NotifyEvent, Project, Task } from '@agentdesk/core';
import { buildEventMarkdown } from '../src/dingtalk-markdown.js';
import { DedupedNotifier } from '../src/notify-base.js';

const project: Project = { id: 1, name: 'selftest', workspace_path: '', agent_id: 'codex', created_at: '' };
const task: Task = { id: 55, project_id: 1, prompt: '原始任务内容'.repeat(50), status: 'done', created_at: '' };

test('DingTalk completion notification preserves long Markdown and every detail', () => {
  const table = '| 日期 | 气温 |\n|---|---|\n| 周一 | 13–19℃ |\n| 周日 | 8–16℃ |';
  const agentMessage = '天气预报。'.repeat(70) + '\n\n' + table;
  const filesChanged = Array.from({ length: 7 }, (_, i) => `file-${i}.txt`);
  const diffStat = filesChanged.map(name => `${name} | 1 +`).join('\n');
  const remaining = '未完成的内容。'.repeat(50);
  const markdown = buildEventMarkdown({
    kind: 'run.succeeded', runId: 1, task, project, summary: { agentMessage, filesChanged, diffStat, partial: true, remaining },
  }, '')!.text;
  for (const detail of [agentMessage, ...filesChanged, diffStat, remaining]) {
    assert.ok(markdown.includes(detail), `Missing detail: ${detail.slice(0, 40)}`);
  }
  assert.match(markdown, /继续 55/);
});

test('DingTalk start and failure notifications preserve the full task and reason', () => {
  const reason = '运行失败的原因。'.repeat(50);
  assert.ok(buildEventMarkdown({ kind: 'run.started', runId: 1, task, project }, '')!.text.includes(task.prompt));
  assert.ok(buildEventMarkdown({ kind: 'run.failed', runId: 1, task, project, reason }, '')!.text.includes(reason));
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
  assert.match(text, /Git 操作进行中/);
  assert.match(text, /继续 55/);
});
