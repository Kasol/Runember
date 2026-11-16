import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { applyTaskAction } from '../src/actions.js';
import { parseCommand } from '../src/dingtalk-stream.js';
import type { Scheduler } from '../src/scheduler.js';
import { Store } from '../src/store.js';

test('DingTalk accepts bare task numbers and preserves numbers inside descriptions', () => {
  assert.deepEqual(parseCommand('状态 55'), { type: 'status', taskId: 55 });
  assert.deepEqual(parseCommand('status #55'), { type: 'status', taskId: 55 });
  assert.deepEqual(parseCommand('详情'), { type: 'status' });
  assert.deepEqual(parseCommand('执行 55'), { type: 'run', taskId: 55, prompt: undefined });
  assert.deepEqual(parseCommand('执行 55行以内写个示例'), { type: 'run', prompt: '55行以内写个示例' });
  assert.deepEqual(parseCommand('55 继续：可以合并'), { type: 'resume', taskId: 55, feedback: '可以合并' });
  assert.deepEqual(parseCommand('resume #55'), { type: 'resume', taskId: 55, feedback: undefined });
  assert.deepEqual(parseCommand('55 取消'), { type: 'cancel', taskId: 55 });
  assert.deepEqual(parseCommand('retry 55'), { type: 'retry', taskId: 55 });
  for (const invalid of ['继续', '继续看看', '继续 55行', '55 继续看看', '55 算了', '终止 55']) {
    assert.deepEqual(parseCommand(invalid), { type: 'help' });
  }
});

test('DingTalk actions separate draft execution, resume, retry and queries', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-test-commands-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = store.addProject('selftest', dir, 'codex');
  const scheduler = { tickNow() {} } as Scheduler;
  const dispatch = (text: string) => applyTaskAction(store, scheduler, parseCommand(text), 'dingtalk');
  const finished = store.addTask(project.id, '已完成任务');
  const run = store.beginRun(finished.id)!;
  store.finishRun(run.id, {
    status: 'succeeded', summary_json: JSON.stringify({ agentMessage: '完整的测试总结', filesChanged: [], diffStat: '' }),
  }, 'done', '还有这件事');
  assert.equal((await dispatch(`执行 ${finished.id} 附加描述`)).ok, false);
  assert.equal(store.getTask(finished.id)?.prompt, '已完成任务');
  assert.equal((await dispatch(`重试 ${finished.id}`)).ok, false);
  const detail = await dispatch(`状态 ${finished.id}`);
  for (const content of ['完整的测试总结', '部分完成', '还有这件事']) assert.ok(detail.message.includes(content));
  assert.equal((await dispatch(`${finished.id} 继续`)).ok, true);
  assert.equal(store.getTask(finished.id)?.pending_feedback, '请继续完成剩余部分');

  assert.equal((await dispatch('草稿 selftest 55行以内写个示例')).ok, true);
  const draft = store.listDrafts()[0]!;
  assert.equal(draft.prompt, '55行以内写个示例');
  assert.equal((await dispatch(`执行 ${draft.id}`)).ok, true);
  assert.match((await dispatch('状态')).message, /排队 2/);
  assert.equal((await dispatch(`${draft.id} 取消`)).ok, true);
  assert.equal(store.getTask(draft.id)?.status, 'cancelled');

  const failed = store.addTask(project.id, '失败的任务');
  store.setTaskStatus(failed.id, 'failed');
  assert.equal((await dispatch(`retry ${failed.id}`)).ok, true);
  assert.equal(store.getTask(failed.id)?.status, 'queued');
});
