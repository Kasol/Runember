import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';
import Docker from 'dockerode';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/server.js';
import type { Scheduler } from '../src/scheduler.js';

test('log directory settings validate access, persist for restart and preserve historical log paths', async t => {
  const dir = mkdtempSync(resolve('data', 'test-log-settings-'));
  const old = join(dir, 'old-logs'), next = join(dir, 'new-logs');
  const cfg = loadConfig({ configPath: join(dir, 'absent.json'), dataDir: dir, logDir: old });
  cfg.server.token = '';
  const store = new Store(dir);
  const project = store.addProject('fixture', dir, 'codex');
  const task = store.addTask(project.id, 'fixture');
  const run = store.beginRun(task.id)!;
  store.finishRun(run.id, { status: 'succeeded', log_path: join(old, 'original.jsonl'), session_id: 'original-session' }, 'done');
  const app = buildServer({ cfg, store, docker: new Docker(), notifiers: [], scheduler: { tickNow() {} } as Scheduler });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const patch = (logDir: unknown, remoteAddress = '127.0.0.1', origin?: string) => app.inject({ method: 'PATCH', url: '/api/settings/storage', payload: { logDir }, remoteAddress, headers: origin ? { origin } : {} });
  assert.equal((await patch(next, '192.0.2.1')).statusCode, 403);
  assert.equal((await patch(next, '127.0.0.1', 'https://other.example')).statusCode, 403);
  for (const value of [null, [], 12, 'relative/path', 'bad\0path']) assert.equal((await patch(value)).statusCode, 400);
  const file = join(dir, 'file.txt'); writeFileSync(file, 'unchanged');
  assert.equal((await patch(file)).statusCode, 400);
  const saved = (await patch(next)).json();
  assert.equal(saved.currentDir, old); assert.equal(saved.configuredDir, next); assert.equal(saved.restartRequired, true);
  assert.deepEqual(readdirSync(next), []);
  assert.equal(store.getRun(run.id)?.log_path, join(old, 'original.jsonl'));
  assert.equal(store.lastSessionOfTask(task.id), 'original-session');
  const envBefore = process.env.AGENTDESK_LOG_DIR;
  process.env.AGENTDESK_LOG_DIR = old;
  try {
    const restarted = loadConfig({ configPath: join(dir, 'absent.json'), dataDir: dir });
    assert.equal(restarted.logDir, next);
    assert.equal(loadConfig({ configPath: join(dir, 'absent.json'), dataDir: dir, logDir: old }).logDir, old);
    const followData = (await patch('')).json();
    assert.equal(followData.configuredDir, dir);
    assert.equal(loadConfig({ configPath: join(dir, 'absent.json'), dataDir: dir }).logDir, dir);
  } finally { if (envBefore === undefined) delete process.env.AGENTDESK_LOG_DIR; else process.env.AGENTDESK_LOG_DIR = envBefore; }
});
