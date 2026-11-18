import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Docker from 'dockerode';
import { loadConfig } from '../src/config.js';
import { applyTaskAction } from '../src/actions.js';
import { parseCommand } from '../src/dingtalk-stream.js';
import type { Scheduler } from '../src/scheduler.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

test('task API projects all six states without rewriting the historical runs', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-test-task-state-'));
  const cfg = loadConfig({ configPath: join(dir, 'missing.json'), dataDir: dir });
  cfg.server.token = 'test-api-token';
  const store = new Store(dir);
  const scheduler = { tickNow() {} } as Scheduler;
  const app = buildServer({ cfg, store, scheduler, docker: new Docker(), notifiers: [] });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = store.addProject('fixture', dir, 'codex');
  const headers = { 'x-agentdesk-token': cfg.server.token };
  const prompt = '\n第一行\n  缩进的第二行\n\n';
  const draft = (await app.inject({
    method: 'POST', url: '/api/tasks', headers, payload: { project: project.id, prompt, draft: true },
  })).json().task;
  const saved = (await app.inject({ url: '/api/drafts', headers })).json().drafts;
  assert.equal(saved[0].prompt, prompt);
  assert.equal(saved[0].state, 'draft');
  const cancelled = store.addTask(project.id, 'cancel from queue');
  await applyTaskAction(store, scheduler, parseCommand(`取消 ${cancelled.id}`), 'dingtalk');
  const queued = store.addTask(project.id, 'queued');
  const running = store.addTask(project.id, 'running');
  const active = store.beginRun(running.id)!;
  const waiting = store.addTask(project.id, 'legacy authorisation request');
  const question = store.beginRun(waiting.id)!;
  store.finishRun(question.id, {
    status: 'blocked', exit_code: 0, blocked_kind: 'approval_needed', session_id: 'legacy-session',
    summary_json: JSON.stringify({ agentMessage: '工作说明\n###AGENTCTL_BLOCKED### {"question":"是否授权？"}' }),
  }, 'blocked');
  const ended = store.addTask(project.id, 'legacy test failure');
  const terminal = store.beginRun(ended.id)!;
  const finalAnswer = '   测试未通过，流程已暂停。\n\n[验收报告](https://example.org/report)\n';
  store.finishRun(terminal.id, {
    status: 'blocked', blocked_kind: 'verification_failed', exit_code: 0, session_id: 'older-session',
    started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-01T00:00:02.000Z',
    summary_json: JSON.stringify({ agentMessage: finalAnswer }),
  }, 'blocked', '修复单测');

  const list = (await app.inject({ url: '/api/tasks', headers })).json().tasks;
  for (const [task, state] of [[draft, 'draft'], [queued, 'queued'], [running, 'running'],
    [waiting, 'awaiting_confirmation'], [ended, 'ended'], [cancelled, 'cancelled']] as const) {
    const result = (await app.inject({ url: `/api/tasks/${task.id}`, headers })).json();
    assert.equal(list.find((row: { id: number }) => row.id === task.id).state, state);
    assert.equal(result.task.state, state);
    assert.equal(result.task.status, store.getTask(task.id)?.status);
  }
  const detail = (await app.inject({ url: `/api/tasks/${ended.id}`, headers })).json();
  assert.deepEqual(detail.runs[0], JSON.parse(JSON.stringify(store.getRun(terminal.id))));
  assert.equal(detail.details.exitCode, 0);
  assert.equal(detail.details.elapsedMs, 2000);
  assert.equal(detail.details.agentId, 'codex');
  assert.equal(detail.details.stage, '正常退出');
  assert.equal(detail.details.summary, finalAnswer);
  assert.equal(detail.details.remaining, '修复单测');
  assert.equal(detail.details.artifacts[0].href, 'https://example.org/report');
  assert.equal(detail.actions.resume, 'session');
  assert.equal(detail.actions.retry, true);
  const preparing = (await app.inject({ url: `/api/tasks/${running.id}`, headers })).json();
  assert.equal(preparing.details.id, active.id);
  assert.equal(preparing.details.stage, '准备执行');

  assert.equal((await applyTaskAction(store, scheduler, parseCommand(`执行 ${draft.id}`), 'dingtalk')).ok, true);
  assert.equal(store.getTask(draft.id)?.status, 'queued');
  assert.equal(store.getTask(draft.id)?.prompt, prompt);
});

test('run log pages recover the whole UTF-8 file and native daemon log location stays local', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-test-run-logs-'));
  const cfg = loadConfig({ configPath: join(dir, 'missing.json'), dataDir: dir, logDir: '日志' });
  cfg.server.token = 'test-log-token';
  const store = new Store(dir);
  const app = buildServer({ cfg, store, scheduler: {} as Scheduler, docker: new Docker(), notifiers: [] });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = store.addProject('fixture', dir, 'codex');
  const task = store.addTask(project.id, 'log fixture');
  const run = store.beginRun(task.id)!;
  const logPath = join(dir, 'fixture.jsonl');
  const original = Array.from({ length: 6000 }, (_, i) => `${i} 中文🙂测试输出\n`).join('') + '最后一行\r\n';
  writeFileSync(logPath, original);
  store.updateRun(run.id, { log_path: logPath });

  const url = `/api/runs/${run.id}/log`;
  const headers = { 'x-agentdesk-token': cfg.server.token };
  assert.equal((await app.inject(url)).statusCode, 401);
  assert.equal((await app.inject({ url: url + '?before=0', headers })).statusCode, 400);
  assert.equal((await app.inject({ url: url + '?before=-1', headers })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/runs/999/log', headers })).statusCode, 404);
  const pages: string[] = [];
  let before: number | null = null;
  do {
    const response = await app.inject({ url: before === null ? url : `${url}?before=${before}`, headers });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const page = response.json<{ text: string; before: number | null }>();
    assert.ok(before === null || page.before === null || page.before < before);
    pages.unshift(page.text);
    before = page.before;
  } while (before !== null);
  assert.ok(pages.length > 1);
  assert.equal(pages.join(''), original);

  for (const [location, path] of [[url + '/location', logPath], ['/api/logs/daemon/location', join(cfg.logDir, 'daemon.log')]]) {
    assert.equal((await app.inject({ url: location, headers, remoteAddress: '192.0.2.5' })).statusCode, 403);
    assert.deepEqual((await app.inject({ url: location, headers })).json(), { path });
  }
});

test('the local release serves Web assets while keeping the API and stop endpoint authenticated', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-test-release-'));
  const web = join(dir, 'web');
  mkdirSync(join(web, 'assets'), { recursive: true });
  writeFileSync(join(web, 'index.html'), '<!doctype html><title>agentdesk test</title>');
  writeFileSync(join(web, 'assets', 'app.js'), 'console.log("ready");');
  const cfg = loadConfig({ configPath: join(dir, 'missing.json'), dataDir: dir });
  cfg.server.token = 'test-api-token';
  const store = new Store(dir);
  const project = store.addProject('fixture', dir, 'codex');
  let stopped = false;
  let scheduled = 0;
  const scheduler = { tickNow() { scheduled++; } } as unknown as Scheduler;
  const app = buildServer({ cfg, store, scheduler, docker: new Docker(), notifiers: [], webDir: web,
    control: { instanceId: 'test-instance', key: 'test-control-key', stop: () => { stopped = true; } } });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const page = await app.inject('/?task=1');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /agentdesk test/);
  assert.match((await app.inject('/assets/app.js')).headers['content-type']!, /^text\/javascript/);
  assert.equal((await app.inject('/assets/..%2Fagentdesk.db')).statusCode, 404);
  assert.equal((await app.inject('/api/projects')).statusCode, 401);
  const headers = { 'x-agentdesk-token': cfg.server.token };
  assert.equal((await app.inject({ url: '/api/projects', headers })).statusCode, 200);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/tasks', headers, payload: { project: project.id, prompt: 'read-only smoke' },
  })).statusCode, 201);
  assert.equal(scheduled, 1);
  assert.equal((await app.inject({ method: 'POST', url: '/api/shutdown', headers })).statusCode, 403);
  assert.equal((await app.inject({
    method: 'POST', url: '/api/shutdown', headers: { ...headers, 'x-agentdesk-control': 'test-control-key' },
  })).statusCode, 202);
  assert.equal(stopped, true);
});

test('the Web folder picker browses host directories and requires local origin or an API token', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-test-folders-'));
  const projectDir = join(dir, '测试 repo');
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  mkdirSync(join(projectDir, '子文件夹'));
  writeFileSync(join(projectDir, 'README.md'), 'fixture');
  const cfg = loadConfig({ configPath: join(dir, 'missing.json'), dataDir: dir });
  cfg.server.token = 'test-token';
  const store = new Store(dir);
  const app = buildServer({ cfg, store, scheduler: {} as Scheduler, docker: new Docker(), notifiers: [] });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

  const browse = (payload: object, headers: Record<string, string> = {}) => app.inject({
    method: 'POST', url: '/api/project-folders', payload, headers,
  });
  assert.equal((await browse({ path: projectDir })).statusCode, 401);
  const remote = await browse({ path: projectDir }, { 'x-agentdesk-token': 'test-token' });
  assert.equal(remote.statusCode, 200);
  assert.equal(remote.headers['cache-control'], 'no-store');
  assert.deepEqual(remote.json(), {
    current: { name: '测试 repo', path: projectDir }, parent: dir,
    folders: [{ name: '子文件夹', path: join(projectDir, '子文件夹') }],
  });

  cfg.server.token = '';
  const local = { host: 'localhost:5173', origin: 'http://localhost:5173' };
  assert.equal((await browse({ path: projectDir })).statusCode, 403);
  assert.equal((await browse({}, { host: 'outside.invalid', origin: 'http://outside.invalid' })).statusCode, 403);
  assert.equal((await browse({}, local)).statusCode, 200);
  assert.equal((await browse({ path: 'relative' }, local)).statusCode, 400);
  assert.equal((await browse({ path: join(dir, 'missing') }, local)).statusCode, 404);
});
