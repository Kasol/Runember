import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Docker from 'dockerode';
import { loadConfig } from '../src/config.js';
import type { Scheduler } from '../src/scheduler.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

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
