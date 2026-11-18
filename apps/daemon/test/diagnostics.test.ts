import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';
import Docker from 'dockerode';
import { classifyDiagnosticError, redactDiagnosticText, type Run, type Task } from '@agentdesk/core';
import { diagnoseTask, diagnoseStoredTask, diagnosticExport, errorEvidence } from '../src/diagnostics.js';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/server.js';
import type { Scheduler } from '../src/scheduler.js';

test('diagnosis recognizes startup evidence and ignores business text from successful runs', async t => {
  const dir = mkdtempSync(resolve('data', 'test-diagnostics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'run.jsonl');
  writeFileSync(path, '[stderr] 无法定位 CLI ZCode Built-in Provider Config：D:/missing/config.json\n');
  const task: Task = { id: 20, project_id: 1, agent_id: 'zcode', status: 'failed', prompt: 'PRIVATE PROMPT', created_at: '' };
  const run: Run = { id: 40, task_id: 20, kind: 'normal', agent_id: 'zcode', status: 'failed', exit_code: 1, log_path: path };
  const failed = await diagnoseTask(task, run);
  assert.equal(failed.findings[0]?.code, 'provider_config_missing');
  assert.match(failed.findings[0]!.evidence[0]!.text, /无法定位/);
  assert.ok(!diagnosticExport(failed).includes(task.prompt));
  const normal = await diagnoseTask({ ...task, status: 'done' }, { ...run, status: 'succeeded', exit_code: 0,
    summary_json: JSON.stringify({ agentMessage: '单测没过。示例错误：Unauthorized、ENOENT、permission denied' }) });
  assert.equal(normal.findings[0]?.code, 'normal_exit');
  assert.ok(!normal.findings.some(item => item.level === 'error'));
  const ignored = errorEvidence(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'unauthorized' } }));
  assert.deepEqual(ignored, []);
});

test('diagnostic redaction removes credentials from nested error snippets while preserving valid JSON', () => {
  const secret = 'fixture-secret-123456';
  for (const text of [`Authorization: Bearer ${secret}`, `api_key=${secret}`, `{"client_secret":"${secret}"}`,
    `https://user:${secret}@example.test/api?access_token=${secret}`, `Cookie: a=1; session=${secret}`]) {
    assert.ok(!redactDiagnosticText(text).includes(secret));
  }
  const finding = classifyDiagnosticError('HTTP 401 Unauthorized\nCookie: session=' + secret, 'run')!;
  const value = diagnosticExport({ schemaVersion: 1, product: 'Runember', generatedAt: '', scope: 'task',
    platform: { os: 'win32', arch: 'x64', node: 'v24', version: '2.1.0' }, findings: [finding] });
  assert.equal(JSON.parse(value).product, 'Runember');
  assert.ok(!value.includes(secret));
});

test('offline diagnosis is read-only and task API pins evidence to the selected Run', async t => {
  const dir = mkdtempSync(resolve('data', 'test-diagnostics-api-'));
  const cfg = loadConfig({ configPath: join(dir, 'absent.json'), dataDir: dir, logDir: dir });
  cfg.server.token = 'fixture';
  const store = new Store(dir);
  const project = store.addProject('fixture', dir, 'zcode');
  const task = store.addTask(project.id, 'PRIVATE PROMPT');
  const old = store.beginRun(task.id)!;
  const path = join(dir, 'run.jsonl'); writeFileSync(path, '[stderr] 无法定位 CLI ZCode Built-in Provider Config\n');
  store.finishRun(old.id, { status: 'failed', exit_code: 1, log_path: path }, 'failed');
  const original = store.getRun(old.id);
  const offline = await diagnoseStoredTask(cfg, task.id);
  assert.equal(offline.findings[0]?.code, 'provider_config_missing');
  assert.deepEqual(store.getRun(old.id), original);
  const app = buildServer({ cfg, store, docker: new Docker(), notifiers: [], scheduler: { tickNow() {} } as Scheduler });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal((await app.inject({ url: `/api/tasks/${task.id}/diagnostics` })).statusCode, 401);
  const headers = { 'x-agentdesk-token': 'fixture' };
  const response = await app.inject({ url: `/api/tasks/${task.id}/diagnostics?run=${old.id}`, headers });
  assert.equal(response.json().runId, old.id);
  assert.equal(response.json().findings[0].code, 'provider_config_missing');
  assert.equal((await app.inject({ url: `/api/tasks/${task.id}/diagnostics?run=9999`, headers })).statusCode, 404);
  assert.equal(readFileSync(path, 'utf8'), '[stderr] 无法定位 CLI ZCode Built-in Provider Config\n');
});
