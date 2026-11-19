import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { getAdapter } from '@agentdesk/adapters';
import { classifyRun } from '@agentdesk/core';
import { parse } from 'smol-toml';
import { loadConfig } from '../src/config.js';
import { hostAudit, hostCheckpoint } from '../src/hostgit.js';
import { renderMcpConfig } from '../src/mcp.js';
import { runNative } from '../src/native.js';
import { Runner } from '../src/runner.js';
import { EventBus } from '../src/notify.js';
import type Docker from 'dockerode';
import { Scheduler } from '../src/scheduler.js';
import { Store } from '../src/store.js';

test('validates environment overrides and rejects a remote listener without authentication', t => {
  const key = 'AGENTDESK_SCHEDULER__TASKTIMEOUTMIN';
  const host = 'AGENTDESK_SERVER__HOST';
  const token = 'AGENTDESK_SERVER__TOKEN';
  const before = [key, host, token].map(name => [name, process.env[name]] as const);
  t.after(() => {
    for (const [name, value] of before) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env[key] = '7';
  const configPath = join(tmpdir(), 'agentdesk-env-test-nonexistent.json');
  assert.equal(loadConfig({ configPath }).scheduler.taskTimeoutMin, 7);
  process.env[key] = '-1';
  assert.throws(() => loadConfig({ configPath }), /scheduler.taskTimeoutMin/);
  process.env[key] = '7';
  process.env[host] = '0.0.0.0';
  delete process.env[token];
  assert.throws(() => loadConfig({ configPath }), /server.token/);
  process.env[token] = '123';
  assert.equal(loadConfig({ configPath }).server.token, '123');
});

test('resolves the log directory independently from the data directory', t => {
  const root = mkdtempSync(join(tmpdir(), 'agentdesk-test-log-dir-'));
  const dataDir = join(root, 'data');
  const configPath = join(root, 'config.json');
  const previous = process.env.AGENTDESK_LOG_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTDESK_LOG_DIR;
    else process.env.AGENTDESK_LOG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  delete process.env.AGENTDESK_LOG_DIR;
  assert.equal(loadConfig({ configPath, dataDir }).logDir, dataDir);

  writeFileSync(configPath, JSON.stringify({ logDir: 'local logs' }));
  assert.equal(loadConfig({ configPath, dataDir }).logDir, join(dataDir, 'local logs'));

  process.env.AGENTDESK_LOG_DIR = join(root, 'external logs');
  const cfg = loadConfig({ configPath, dataDir });
  assert.equal(cfg.logDir, process.env.AGENTDESK_LOG_DIR);
  assert.equal(cfg.dataDir, dataDir);
  assert.equal(loadConfig({ configPath, dataDir, logDir: 'override' }).logDir, join(dataDir, 'override'));
});

test('normal exit ignores business outcomes and waits only for an explicit input request', () => {
  const exit = { exitCode: 0, killed: false, errTail: '' };
  assert.deepEqual(classifyRun({ ...exit, lastAgentText: 'finished' }), { status: 'succeeded' });
  assert.deepEqual(classifyRun({ ...exit, lastAgentText: '  ' }), { status: 'succeeded' });
  assert.deepEqual(classifyRun({ ...exit, lastAgentText: '###AGENTCTL_BLOCKED### {"question":"Review?"}' }),
    { status: 'blocked', blockedKind: 'approval_needed', inputRequest: 'Review?' });
  assert.deepEqual(classifyRun({ ...exit, lastAgentText: '###AGENTCTL_RESULT### {"done":false}' }), { status: 'succeeded' });
});

test('records executor failures independently of the final answer', () => {
  const exit = { exitCode: 0, killed: false, errTail: '' };
  for (const lastAgentText of [
    '已解决冲突并完成 rebase。\n\n**合并因全量测试未通过而暂停。** 最终候选有 146 项失败。',
    'Merge is blocked because the required tests failed.',
    '###AGENTCTL_BLOCKED### invalid',
    '```text\n###AGENTCTL_BLOCKED### {"question":"Example?"}\n```',
    '> ###AGENTCTL_BLOCKED### {"question":"Example?"}',
  ]) {
    assert.deepEqual(classifyRun({ ...exit, lastAgentText }), { status: 'succeeded' });
  }
  const explicit = { ...exit, lastAgentText: 'Results so far', inputRequest: 'Provide an account?' };
  assert.deepEqual(classifyRun(explicit), { status: 'blocked', blockedKind: 'approval_needed', inputRequest: explicit.inputRequest });
  assert.deepEqual(classifyRun({ ...explicit, exitCode: null, killed: true }), { status: 'blocked', blockedKind: 'timeout' });
  assert.deepEqual(classifyRun({ ...explicit, exitCode: null, interrupted: true }), { status: 'blocked', blockedKind: 'interrupted' });
  assert.deepEqual(classifyRun({ ...exit, exitCode: 1, errTail: '401 Unauthorized', lastAgentText: '' }),
    { status: 'blocked', blockedKind: 'auth_missing' });
  assert.deepEqual(classifyRun({ ...exit, exitCode: 2, lastAgentText: 'Checked an API that returned 401' }),
    { status: 'failed', blockedKind: 'unknown_error' });
});

test('passes task and resume text unchanged to Codex in both execution modes', () => {
  const adapter = getAdapter('codex', 'test-image', 'test-volume');
  const feedback = '--help\n按项目 skill 执行提交';
  assert.deepEqual(adapter.buildArgs('workspace-write', 'capability'),
    ['codex', 'exec', '--json', '--sandbox', 'danger-full-access', '--', 'workspace-write']);
  assert.deepEqual(adapter.buildArgs(feedback, 'isolation'),
    ['codex', 'exec', '--json', '--sandbox', 'workspace-write', '--', feedback]);
  assert.deepEqual(adapter.buildResumeArgs('test-session', feedback, 'capability'),
    ['codex', 'exec', '--sandbox', 'danger-full-access', 'resume', 'test-session', '--json', '--', feedback]);
  assert.deepEqual(adapter.buildArgs(feedback, 'isolation', '/agentdesk-final-response.json'),
    ['codex', 'exec', '--json', '--sandbox', 'workspace-write', '--output-schema', '/agentdesk-final-response.json', '--', feedback]);
  assert.deepEqual(adapter.buildResumeArgs('test-session', feedback, 'capability', 'C:/test/final response.json'),
    ['codex', 'exec', '--sandbox', 'danger-full-access', 'resume', 'test-session', '--json',
      '--output-schema', 'C:/test/final response.json', '--', feedback]);
});

test('Codex separates a structured input request from the user-facing answer', () => {
  const adapter = getAdapter('codex', 'test-image', 'test-volume');
  const message = (text: string) => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });
  const question = '请告诉我城市名称。';
  const waiting = JSON.stringify({ answer: '', input_request: question });
  assert.deepEqual(adapter.parseLine(message(waiting), true), { type: 'agent_message', text: '', final: true, inputRequest: question });
  assert.deepEqual(adapter.parseLine(message(waiting)), { type: 'agent_message', text: waiting });
  const answer = '验收失败，流程已暂停。\n如果需要，我可以继续排查。';
  assert.deepEqual(adapter.parseLine(message(JSON.stringify({ answer, input_request: null })), true),
    { type: 'agent_message', text: answer, final: true, inputRequest: undefined });
  assert.deepEqual(adapter.parseLine(message(question), true), { type: 'agent_message', text: question });
});

test('Codex records observable activity without command output or tool arguments', () => {
  const adapter = getAdapter('codex', 'test-image', 'test-volume');
  const event = (type: string, item: object) => adapter.parseLine(JSON.stringify({ type, item }), true);
  const command = { id: 'cmd', type: 'command_execution',
    command: '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "git status -- private-path"',
    aggregated_output: 'private output',
  };
  assert.deepEqual(event('item.started', command)?.activity,
    { key: 'cmd', kind: 'command', phase: 'started', detail: 'git status' });
  assert.deepEqual(event('item.completed', { ...command, exit_code: 2 })?.activity,
    { key: 'cmd', kind: 'command', phase: 'failed', detail: 'git status' });
  assert.deepEqual(event('item.started', {
    id: 'tool', type: 'mcp_tool_call', tool: 'search_docs', arguments: { token: 'private token' },
  })?.activity, { key: 'tool', kind: 'tool', phase: 'started', detail: 'search_docs' });
  assert.deepEqual(event('item.completed', { id: 'files', type: 'file_change', changes: [{ path: 'a' }, { path: 'b' }] })?.activity,
    { key: 'files', kind: 'files', phase: 'completed', detail: '2 项' });
  const progress = event('item.completed', { id: 'msg', type: 'agent_message', text: '已定位失败用例。\n正在检查相关文件。' });
  assert.equal(progress?.activity?.detail, '已定位失败用例。 正在检查相关文件。');
  assert.equal(event('item.completed', { id: 'final', type: 'agent_message', text: '{"answer":"done","input_request":null}' })?.activity, undefined);
});

test('an exited native process settles even when its background child keeps its pipes open', { timeout: 10_000 }, async t => {
  const parent = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 7000)'], {",
    "  detached: true, windowsHide: true, stdio: ['ignore', 1, 2],",
    "});",
    "child.unref();",
    "console.log(child.pid);",
    "process.stdout.write('最后一条回复');",
  ].join('\n');
  let backgroundPid: number | undefined;
  t.after(() => {
    if (backgroundPid) {
      try { process.kill(backgroundPid); } catch { /* fixture already exited */ }
    }
  });
  const output: string[] = [];
  const result = await runNative({
    cmd: [process.execPath, '-e', parent], cwd: process.cwd(), timeoutMs: 3_000,
    onStdoutLine: line => {
      if (backgroundPid === undefined) backgroundPid = Number(line);
      else output.push(line);
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.killed, false);
  assert.deepEqual(output, ['最后一条回复']);
  assert.ok(backgroundPid);
  assert.doesNotThrow(() => process.kill(backgroundPid!, 0));
});

test('builds independent MCP config overlays and preserves the other Codex settings', () => {
  const base = 'model = "example"\n[mcp_servers.previous]\ncommand = "old"\n';
  const first = renderMcpConfig(base, ['first.server', 'unknown'], {
    'first.server': { command: 'C:\\Tools\\first.exe', args: ['an "argument"'] },
  });
  const second = renderMcpConfig(base, ['second'], { second: { url: 'http://example.invalid' } });
  assert.deepEqual(first.written, ['first.server']);
  assert.deepEqual(first.skipped, ['unknown']);
  assert.equal(parse(first.toml).model, 'example');
  const firstServers = parse(first.toml).mcp_servers as Record<string, { command: string }>;
  assert.deepEqual(Object.keys(firstServers), ['first.server']);
  assert.equal(firstServers['first.server']?.command, 'C:\\Tools\\first.exe');
  assert.deepEqual(Object.keys(parse(second.toml).mcp_servers as object), ['second']);
});

test('checkpoint records worktree changes and preserves HEAD and the real index', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-test-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Agentdesk Test');
  git('config', 'user.email', 'agentdesk-test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'tracked.txt'), 'initial');
  git('add', 'tracked.txt');
  git('commit', '-qm', 'initial');
  const head = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'tracked.txt'), 'staged');
  git('add', 'tracked.txt');
  writeFileSync(join(dir, 'tracked.txt'), 'working tree');
  writeFileSync(join(dir, 'untracked.txt'), 'existing untracked');
  const index = join(dir, '.git', 'index');
  const before = readFileSync(index);
  const checkpoint = await hostCheckpoint(dir, 1);
  assert.equal(checkpoint.ok, true, checkpoint.error);
  assert.equal(git('show', checkpoint.anchor + ':tracked.txt'), 'working tree');
  assert.equal(git('show', checkpoint.anchor + ':untracked.txt'), 'existing untracked');
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.deepEqual(readFileSync(index), before);
  assert.deepEqual((await hostAudit(dir, checkpoint.anchor)).filesChanged, []);
  writeFileSync(join(dir, 'added.txt'), 'agent result');
  assert.deepEqual((await hostAudit(dir, checkpoint.anchor)).filesChanged, ['A\tadded.txt']);

  writeFileSync(join(dir, '.gitattributes'), 'added.txt filter=broken\n');
  git('config', 'filter.broken.clean', 'nonexistent-agentdesk-test-filter');
  git('config', 'filter.broken.required', 'true');
  const failed = await hostCheckpoint(dir, 2);
  assert.equal(failed.ok, false);
  assert.match(failed.error!, /git add/);
  assert.deepEqual(readFileSync(index), before);

  mkdirSync(join(dir, '.git', 'rebase-merge'));
  assert.match((await hostCheckpoint(dir, 3)).error!, /rebase-merge/);
  assert.deepEqual(readFileSync(index), before);
});

test('holds a recovered live worker and refills exactly one freed slot', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-test-store-'));
  const store = new Store(dir);
  const cfg = loadConfig({ configPath: join(dir, 'missing.json') });
  cfg.scheduler.concurrency = 2;
  cfg.scheduler.tickMs = 60_000;
  const roots = ['first', 'second', 'third'].map(name => {
    const path = join(dir, name);
    mkdirSync(path);
    return store.addProject(name, path, 'codex');
  });
  const alias = store.addProject('alias', join(roots[0]!.workspace_path, '.'), 'codex');
  const interrupted = store.addTask(roots[0]!.id, 'interrupted');
  const old = store.beginRun(interrupted.id)!;
  store.updateRun(old.id, { status: 'running', session_id: 'old-session', worker: { kind: 'native', pid: 1 } });
  const samePath = store.addTask(alias.id, 'same path');
  const second = store.addTask(roots[1]!.id, 'second path');
  const third = store.addTask(roots[2]!.id, 'third path');

  let workerAlive = true;
  const release = new Map<number, () => void>();
  const runner = {
    async recoverRun(run: Parameters<Store['interruptRun']>[0]) {
      if (workerAlive) return false;
      store.interruptRun(run);
      return true;
    },
    async execute(taskId: number) {
      const run = store.beginRun(taskId)!;
      store.updateRun(run.id, { status: 'running' });
      await new Promise<void>(done => release.set(taskId, done));
      store.finishRun(run.id, { status: 'succeeded' }, 'done');
    },
  } as unknown as Runner;
  const scheduler = new Scheduler(cfg, store, runner);
  t.after(async () => {
    scheduler.stop();
    for (const done of release.values()) done();
    await scheduler.drain();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  scheduler.start();
  await setImmediate();
  assert.deepEqual([...release.keys()], [second.id]);
  workerAlive = false;
  scheduler.tickNow();
  await setImmediate();
  assert.equal(store.getTask(interrupted.id)?.status, 'blocked');
  assert.equal(store.getRun(old.id)?.blocked_kind, 'interrupted');
  assert.equal(store.lastSessionOfTask(interrupted.id), 'old-session');
  assert.deepEqual([...release.keys()], [second.id, samePath.id]);
  release.get(second.id)!();
  await setImmediate();
  assert.deepEqual([...release.keys()], [second.id, samePath.id, third.id]);
});

test('holds a cancelled container until Docker confirms its exit, retaining a natural exit', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-cancel-docker-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const cfg = loadConfig({ configPath: join(dir, 'missing.json'), dataDir: dir });
  const project = store.addProject('docker fixture', dir, 'codex', 'isolation');
  const task = store.addTask(project.id, 'long task');
  const run = store.beginRun(task.id)!;
  store.updateRun(run.id, { status: 'running', worker: { kind: 'docker', id: 'first' } });
  store.requestCancellation(task.id);
  let reachable = false;
  let running = true;
  let kills = 0;
  const finishedAt = new Date().toISOString();
  const docker = {
    getContainer(id: string) {
      return {
        async inspect() {
          if (!reachable) throw new Error('Docker unavailable');
          if (id === 'second') return { State: { Status: 'exited', ExitCode: 0, FinishedAt: finishedAt } };
          return { State: running ? { Running: true } : { Status: 'exited', ExitCode: 137, FinishedAt: finishedAt } };
        },
        async kill() { kills++; },
        async remove() {},
      };
    },
  } as unknown as Docker;
  const runner = new Runner({ store, docker, cfg, events: new EventBus([]) });
  const active = () => store.getRun(run.id)!;
  assert.equal(await runner.recoverRun(active()), false);
  assert.match(active().cancellation?.issue ?? '', /Docker unavailable/);
  assert.equal(store.getTask(task.id)?.status, 'running');
  reachable = true;
  assert.equal(await runner.recoverRun(active()), false);
  assert.equal(await runner.recoverRun(active()), false);
  assert.equal(kills, 1);
  assert.equal(store.getTask(task.id)?.status, 'running');
  running = false;
  assert.equal(await runner.recoverRun(active()), true);
  assert.equal(store.getTask(task.id)?.status, 'cancelled');
  assert.equal(active().execution?.stoppedAt, finishedAt);

  const nextTask = store.addTask(project.id, 'natural exit');
  const next = store.beginRun(nextTask.id)!;
  store.updateRun(next.id, { status: 'running', worker: { kind: 'docker', id: 'second' } });
  const late = store.requestCancellation(nextTask.id)!;
  assert.equal(await runner.recoverRun(late), true);
  assert.equal(store.getTask(nextTask.id)?.status, 'done');
  assert.equal(store.getRun(next.id)?.exit_code, 0);
  assert.equal(kills, 1);
});
