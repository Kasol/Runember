import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, Task } from '@agentdesk/core';
import { buildEventMarkdown } from '../src/dingtalk-markdown.js';

const project: Project = { id: 1, name: 'selftest', workspace_path: '', agent_id: 'codex', created_at: '' };
const task: Task = { id: 55, project_id: 1, prompt: '原始任务内容'.repeat(50), status: 'done', created_at: '' };

test('DingTalk completion notification preserves long Markdown and every detail', () => {
  const table = '| 日期 | 气温 |\n|---|---|\n| 周一 | 13–19℃ |\n| 周日 | 8–16℃ |';
  const agentMessage = '天气预报。'.repeat(70) + '\n\n' + table;
  const filesChanged = Array.from({ length: 7 }, (_, i) => `file-${i}.txt`);
  const diffStat = filesChanged.map(name => `${name} | 1 +`).join('\n');
  const remaining = '未完成的内容。'.repeat(50);
  const markdown = buildEventMarkdown({
    kind: 'run.succeeded', task, project, summary: { agentMessage, filesChanged, diffStat, partial: true, remaining },
  }, '')!.text;
  for (const detail of [agentMessage, ...filesChanged, diffStat, remaining]) {
    assert.ok(markdown.includes(detail), `Missing detail: ${detail.slice(0, 40)}`);
  }
  assert.match(markdown, /继续 55/);
});

test('DingTalk start and failure notifications preserve the full task and reason', () => {
  const reason = '运行失败的原因。'.repeat(50);
  assert.ok(buildEventMarkdown({ kind: 'run.started', task, project }, '')!.text.includes(task.prompt));
  assert.ok(buildEventMarkdown({ kind: 'run.failed', task, project, reason }, '')!.text.includes(reason));
});
