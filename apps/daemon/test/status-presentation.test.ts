import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { formatDuration, runDetails, runTiming, taskDescriptions } from '@agentdesk/core';
import { Store } from '../src/store.js';
import { applyTaskAction } from '../src/actions.js';
import type { Scheduler } from '../src/scheduler.js';

test('duration formatting omits zero units in every client language', () => {
  for (const [seconds, expected] of [[97501, '1d3h5m1s'], [18000, '5h'], [420, '7m'], [50, '50s'], [0, '0s'], [0.9, '0s']] as const) {
    assert.equal(formatDuration(seconds * 1000), expected);
    const details = runDetails({ id: 1, task_id: 1, kind: 'normal', status: 'succeeded', exit_code: 0 });
    details.elapsedMs = seconds * 1000;
    for (const language of ['zh-CN', 'en'] as const) assert.ok(runTiming(details, language).endsWith(expected));
  }
});

test('status keeps original and per-run descriptions across restarts without duplicate activities or active log paths', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'runember-status-'));
  let store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = store.addProject('selftest', dir, 'codex');
  const task = store.addTask(project.id, '原始描述\n第二行');
  const first = store.beginRun(task.id)!;
  store.finishRun(first.id, { status: 'succeeded', exit_code: 0 }, 'done');
  store.setPendingFeedback(task.id, '本轮补充\n保留上下文');
  store.setTaskStatus(task.id, 'queued');
  assert.equal(taskDescriptions(store.getTask(task.id)!, store.runsOfTask(task.id)).current, '本轮补充\n保留上下文');
  const next = store.beginRun(task.id)!;
  store.updateRun(next.id, { status: 'running', log_path: join(dir, 'private.log'), summary_json: JSON.stringify({ agentMessage: '正在检查', filesChanged: [], diffStat: '' }) });
  store.close(); store = new Store(dir);
  assert.deepEqual(taskDescriptions(store.getTask(task.id)!, store.runsOfTask(task.id)), { original: task.prompt, current: '本轮补充\n保留上下文' });
  for (const language of ['zh-CN', 'en'] as const) {
    const reply = await applyTaskAction(store, {} as Scheduler, { type: 'status', taskId: task.id, language }, 'dingtalk');
    assert.match(reply.message, /原始描述\n第二行/);
    assert.match(reply.message, /本轮补充\n保留上下文/);
    assert.match(reply.message, /正在检查/);
    assert.doesNotMatch(reply.message, /最近活动（最多|Recent activity \(up to|private.log|完整日志|Full log/);
  }
  const legacy = { ...next, prompt: undefined };
  assert.equal(taskDescriptions(task, [legacy]).current, undefined);
  store.finishRun(next.id, { status: 'succeeded', exit_code: 0 }, 'done');
  assert.match((await applyTaskAction(store, {} as Scheduler, { type: 'status', taskId: task.id }, 'dingtalk')).message, /private.log/);
});
