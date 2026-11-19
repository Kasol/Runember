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
  assert.deepEqual(parseCommand('最近活动 55'), { type: 'activity', taskId: 55 });
  assert.deepEqual(parseCommand('activity #55'), { type: 'activity', taskId: 55 });
  assert.deepEqual(parseCommand('最近活动'), { type: 'activity' });
  assert.deepEqual(parseCommand('详情'), { type: 'status' });
  assert.deepEqual(parseCommand('执行 55'), { type: 'run', taskId: 55, prompt: undefined });
  assert.deepEqual(parseCommand('执行 55行以内写个示例'), { type: 'run', prompt: '55行以内写个示例' });
  assert.deepEqual(parseCommand('55 继续：可以合并'), { type: 'resume', taskId: 55, feedback: '可以合并' });
  assert.deepEqual(parseCommand('resume #55'), { type: 'resume', taskId: 55, feedback: undefined });
  assert.deepEqual(parseCommand('55 取消'), { type: 'cancel', taskId: 55 });
  assert.deepEqual(parseCommand('retry 55'), { type: 'resume', taskId: 55, feedback: undefined });
  assert.deepEqual(parseCommand('重试 55 确认继续'), { type: 'resume', taskId: 55, feedback: '确认继续' });
  assert.deepEqual(parseCommand('开始 55'), { type: 'run', taskId: 55, prompt: undefined });
  assert.deepEqual(parseCommand('start selftest Check the queue'), { type: 'run', prompt: 'selftest Check the queue' });
  assert.deepEqual(parseCommand('开始【my project】检查两项\n保留换行'), { type: 'run', projectName: 'my project', prompt: '检查两项\n保留换行' });
  assert.deepEqual(parseCommand('开始【55】'), { type: 'run', taskId: 55, prompt: undefined });
  assert.deepEqual(parseCommand('草稿 selftest some task'), { type: 'help' });
  assert.deepEqual(parseCommand('draft some task'), { type: 'help' });
  for (const invalid of ['继续', '继续看看', '继续 55行', '55 继续看看', '55 算了', '终止 55']) {
    assert.deepEqual(parseCommand(invalid), { type: 'help' });
  }
});

test('recent activity shows a bounded, durable list for the current Run', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-test-activity-'));
  let store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = store.addProject('selftest', dir, 'codex');
  const scheduler = {} as Scheduler;
  const dispatch = (text: string) => applyTaskAction(store, scheduler, parseCommand(text), 'dingtalk');
  const task = store.addTask(project.id, 'activity fixture');
  assert.match((await dispatch('最近活动')).message, /填写任务编号/);
  assert.match((await dispatch('最近活动 99999')).message, /不存在/);
  assert.match((await dispatch(`最近活动 ${task.id}`)).message, /没有运行记录/);
  const previous = store.beginRun(task.id)!;
  const at = new Date(Date.now() - 180_000).toISOString();
  store.recordRunActivity(previous.id, { key: 'old', kind: 'turn', phase: 'started', at });
  store.finishRun(previous.id, { status: 'succeeded' }, 'done');
  store.setPendingFeedback(task.id, 'continue');
  store.setTaskStatus(task.id, 'queued');
  const run = store.beginRun(task.id)!;
  assert.match((await dispatch(`最近活动 ${task.id}`)).message, /暂无已记录/);
  for (let i = 1; i <= 12; i++) {
    store.recordRunActivity(run.id, { key: `job-${i}`, kind: 'command', phase: 'started', detail: `job ${i}`, at });
  }
  store.recordRunActivity(run.id, { key: 'job-12', kind: 'command', phase: 'completed', detail: 'npm test\n12 cases', at });
  store.recordRunActivity(run.id, { key: 'job-12', kind: 'command', phase: 'started', detail: 'late message', at });
  store.close();
  store = new Store(dir);
  const reply = await dispatch(`最近活动 ${task.id}`);
  assert.equal(reply.ok, true);
  assert.match(reply.message, new RegExp(`Run #${run.id} · ▶️ 运行中`));
  assert.match(reply.message, /最近一次活动：3 分钟前/);
  assert.match(reply.message, /命令执行结束 · npm test/);
  assert.doesNotMatch(reply.message, /Agent 开始执行|job [12]\n|late message/);
  assert.equal(store.recentRunActivities(run.id).length, 10);
  const status = (await dispatch(`状态 ${task.id}`)).message;
  assert.doesNotMatch(status, /最近活动（最多 10 条）|npm test 12 cases/);
  assert.match(status, /原始描述[\s\S]*activity fixture/);
  assert.match(status, /本轮描述[\s\S]*continue/);
  assert.doesNotMatch(status, /最近活动 \d+`/);
});

test('DingTalk reports accepted cancellation as stopping and pins repeated requests to one Run', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-test-cancel-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = store.addProject('selftest', dir, 'codex');
  const scheduler = { stopRun() {}, tickNow() {} } as unknown as Scheduler;
  const dispatch = (text: string) => applyTaskAction(store, scheduler, parseCommand(text), 'dingtalk');
  const task = store.addTask(project.id, '运行中的测试');
  const run = store.beginRun(task.id)!;
  store.updateRun(run.id, { status: 'running', session_id: 'fixture-session' });
  const first = await dispatch(`取消 ${task.id}`);
  assert.match(first.message, /正在停止/);
  const requested = store.getRun(run.id)?.cancellation;
  assert.ok(requested?.requestedAt);
  assert.equal(store.getTask(task.id)?.status, 'running');
  assert.match((await dispatch(`状态 ${task.id}`)).message, /运行中 · 正在停止/);
  assert.equal((await dispatch(`取消 ${task.id}`)).message, first.message);
  assert.deepEqual(store.getRun(run.id)?.cancellation, requested);
  store.finishRun(run.id, { status: 'cancelled', ended_at: new Date().toISOString() }, 'cancelled');
  assert.match((await dispatch(`状态 ${task.id}`)).message, /已取消/);
  assert.equal((await dispatch(`继续 ${task.id} 原会话测试`)).ok, true);
  assert.equal((await applyTaskAction(store, scheduler, { type: 'cancel', taskId: task.id, runId: run.id })).ok, false);
  assert.equal(store.getTask(task.id)?.status, 'queued');
  const resumed = store.beginRun(task.id)!;
  assert.equal(resumed.kind, 'resume');
  assert.equal(resumed.cancellation, undefined);
  assert.equal(store.requestCancellation(task.id, run.id), undefined);
});

test('DingTalk starts dashboard drafts and combines retry with session continuation', async t => {
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
  const detail = await dispatch(`状态 ${finished.id}`);
  for (const content of ['完整的测试总结', '**⏹ 已结束 · 已停止**', '**待完成**\n\n还有这件事']) {
    assert.ok(detail.message.includes(content));
  }
  assert.doesNotMatch(detail.message, /\*\*卡点\*\*/);
  assert.match((await dispatch('状态')).message, /🟡 等待确认 0/);
  assert.equal((await dispatch(`${finished.id} 继续`)).ok, true);
  assert.equal(store.getTask(finished.id)?.pending_feedback, '请继续完成剩余部分');

  const before = store.listTasks().length;
  await dispatch('草稿 selftest 55行以内写个示例');
  await dispatch('draft selftest 55行以内写个示例');
  assert.equal(store.listTasks().length, before);
  assert.equal((await applyTaskAction(store, scheduler, { type: 'draft', prompt: 'selftest no draft' }, 'dingtalk')).ok, false);
  const draft = store.addTask(project.id, '55行以内写个示例', { draft: true });
  assert.equal(draft.prompt, '55行以内写个示例');
  assert.equal((await dispatch(`开始 ${draft.id}`)).ok, true);
  assert.match((await dispatch('状态')).message, /⏳ 排队 2/);
  assert.match((await dispatch(`${draft.id} 取消`)).message, /^🚫/);
  assert.equal(store.getTask(draft.id)?.status, 'cancelled');
  assert.match((await dispatch(`状态 ${draft.id}`)).message, /\*\*🚫 已取消\*\*/);

  const failed = store.addTask(project.id, '失败的任务');
  store.setTaskStatus(failed.id, 'failed');
  assert.equal((await dispatch(`retry ${failed.id}`)).ok, true);
  assert.equal(store.getTask(failed.id)?.status, 'queued');
  assert.equal(store.getTask(failed.id)?.pending_feedback, '请继续');

  const olderPause = store.addTask(project.id, '旧版记为完成的 Git 冲突草案');
  const oldRun = store.beginRun(olderPause.id)!;
  store.finishRun(oldRun.id, { status: 'succeeded', session_id: 'old-codex-session' }, 'done');
  assert.match((await dispatch(`状态 ${olderPause.id}`)).message, /\*\*⏹ 已结束 · 已停止\*\*/);
  assert.equal((await dispatch(`继续 ${olderPause.id} 确认按草案继续`)).ok, true);
  assert.equal(store.getTask(olderPause.id)?.pending_feedback, '确认按草案继续');
  assert.equal(store.lastSessionOfTask(olderPause.id), 'old-codex-session');

  const noSession = store.addTask(project.id, 'ended without a session');
  const noSessionRun = store.beginRun(noSession.id)!;
  store.finishRun(noSessionRun.id, { status: 'succeeded', exit_code: 0 }, 'done');
  assert.match((await dispatch(`继续 ${noSession.id}`)).message, /以新会话继续/);

  const aliasTask = store.addTask(project.id, 'retry alias retains session');
  const aliasRun = store.beginRun(aliasTask.id)!;
  store.finishRun(aliasRun.id, { status: 'succeeded', session_id: 'keep-session' }, 'done');
  assert.match((await dispatch(`重试 ${aliasTask.id} keep my feedback`)).message, /恢复原会话/);
  assert.equal(store.lastSessionOfTask(aliasTask.id), 'keep-session');
  assert.equal(store.getTask(aliasTask.id)?.pending_feedback, 'keep my feedback');

  const blocked = store.addTask(project.id, '等待处理冲突');
  const blockedRun = store.beginRun(blocked.id)!;
  store.finishRun(blockedRun.id, {
    status: 'blocked', blocked_kind: 'approval_needed',
    summary_json: JSON.stringify({
      agentMessage: '已有验收证据\n###AGENTCTL_BLOCKED### {"question":"需要测试账号"}',
      remaining: '双端验收', filesChanged: [], diffStat: '',
    }),
  }, 'blocked');
  const blockedDetail = (await dispatch(`状态 ${blocked.id}`)).message;
  assert.match(blockedDetail, /\*\*🟡 等待确认\*\*/);
  assert.match(blockedDetail, /\*\*等待确认\*\*\n\n需要测试账号/);
  assert.ok(blockedDetail.indexOf('需要测试账号') < blockedDetail.indexOf('Run #'));
  assert.match(blockedDetail, /\*\*待完成\*\*\n\n双端验收/);
  assert.doesNotMatch(blockedDetail, /###AGENTCTL_/);
  const queue = (await dispatch('状态')).message;
  assert.match(queue, new RegExp(`#${blocked.id}\\*\\* selftest · 🟡 等待确认`));
  assert.match(queue, new RegExp(`#${draft.id}\\*\\* selftest · 🚫 已取消`));
});
