import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { classifyRun } from '@agentdesk/core';
import { parse } from 'smol-toml';
import { loadConfig } from '../src/config.js';
import { hostAudit, hostCheckpoint } from '../src/hostgit.js';
import { renderMcpConfig } from '../src/mcp.js';
import type { Runner } from '../src/runner.js';
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

test('blocks a zero-exit ordinary run without an agent result', () => {
  assert.deepEqual(classifyRun({ exitCode: 0, lastAgentText: 'finished', killed: false, errTail: '' }),
    { status: 'blocked', blockedKind: 'missing_result' });
  assert.equal(classifyRun({ exitCode: 0, lastAgentText: '###AGENTCTL_RESULT### {"done":true}', killed: false, errTail: '' }).status,
    'succeeded');
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
    workerIsAlive: async () => workerAlive,
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
