import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import Docker from 'dockerode';
import { getAdapter } from '@agentdesk/adapters';
import { runDetails } from '@agentdesk/core';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { prepareNativeAgent } from '../src/agent-runtime.js';
import { runNative } from '../src/native.js';
import { buildServer } from '../src/server.js';
import type { Scheduler } from '../src/scheduler.js';

test('Agent protocols map observed model, session, tools and required input without exposing arguments', () => {
  const zcode = getAdapter('zcode', '', '');
  const encode = (type: string, payload: object) => JSON.stringify({ type, sessionId: 'sess-test', payload });
  assert.equal(zcode.parseLine(encode('session.created', {}))?.sessionId, 'sess-test');
  assert.equal(zcode.parseLine(encode('turn.started', { intent: { modelSelection: { providerId: 'p', modelId: 'm' } } }))?.model, 'p/m');
  const tool = zcode.parseLine(encode('tool.updated', { kind: 'scheduled', toolCallId: 'tool', toolName: 'Bash', input: { password: 'never-show-this' } }));
  assert.equal(tool?.activity?.phase, 'started');
  assert.doesNotMatch(JSON.stringify(tool), /never-show-this|password/);
  assert.equal(zcode.parseLine(encode('tool.updated', { kind: 'result', toolCallId: 'tool', result: {} }))?.activity?.phase, 'completed');
  assert.equal(zcode.parseLine(encode('tool.updated', { kind: 'error', toolCallId: 'tool', error: { message: 'failure' } }))?.activity?.phase, 'failed');
  assert.equal(zcode.parseLine(encode('userInput.requested', { prompt: 'Choose an account' }))?.text, 'Choose an account');
  assert.match(zcode.parseLine(encode('permission.requested', { toolName: 'AskUserQuestion', reason: 'Tool requires user interaction',
    input: { questions: [{ question: 'Choose A or B?', options: [{ label: 'A' }, { label: 'B' }] }] } }))?.text ?? '', /Choose A or B\?\n- A\n- B/);
  assert.equal(zcode.parseLine(encode('turn.completed', { response: 'raw answer\n  keep indentation' }))?.text, 'raw answer\n  keep indentation');
  const deepseek = getAdapter('deepseek', '', '');
  assert.equal(deepseek.parseLine('{"type":"session","sessionId":"session-test"}')?.sessionId, 'session-test');
  assert.equal(deepseek.parseLine('{"type":"tool_call","callId":"call","tool":"pwsh","input":{"secret":"never-show-this"}}')?.activity?.detail, 'pwsh');
  assert.doesNotMatch(JSON.stringify(deepseek.parseLine('{"type":"tool_result","callId":"call","status":"error","result":"secret output"}')), /secret output/);
  assert.equal(deepseek.parseLine('{"type":"final","text":"the full answer"}')?.text, 'the full answer');
  for (const adapter of [zcode, deepseek]) for (const line of ['noise', '{', 'null', '[]']) assert.equal(adapter.parseLine(line), null);
  const codex = getAdapter('codex', '', '');
  assert.ok(codex.buildArgs('raw task', 'capability', undefined, 'chosen-model').includes('chosen-model'));
  assert.ok(codex.buildResumeArgs('session', 'raw feedback', 'capability', undefined, 'chosen-model').includes('chosen-model'));
});

test('old databases stay readable and new tasks pin their Agent and model across project changes', t => {
  const dir = mkdtempSync(resolve('data', 'test-agent-upgrade-'));
  let store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = store.addProject('fixture', dir, 'codex');
  const oldTask = store.addTask(project.id, 'old task');
  const oldRun = store.beginRun(oldTask.id)!;
  store.finishRun(oldRun.id, { status: 'succeeded', exit_code: 0, session_id: 'codex-session' }, 'done');
  store.close();
  const old = new DatabaseSync(join(dir, 'agentdesk.db'));
  for (const [table, fields] of [['projects', ['model']], ['tasks', ['agent_id', 'model', 'execution']], ['runs', ['agent_id', 'model']]] as const) for (const field of fields) old.exec(`ALTER TABLE ${table} DROP COLUMN ${field}`);
  old.close();
  store = new Store(dir);
  store.updateProject(project.id, { agent_id: 'zcode', model: 'provider/model' });
  assert.equal(store.getTask(oldTask.id)?.agent_id, 'codex');
  assert.equal(store.lastSessionOfTask(oldTask.id), 'codex-session');
  const task = store.addTask(project.id, 'new task', { draft: true });
  store.updateProject(project.id, { agent_id: 'deepseek', model: 'deepseek-account/deepseek-flash' });
  assert.equal(store.getTask(task.id)?.agent_id, 'zcode');
  assert.equal(store.getTask(task.id)?.model, 'provider/model');
  store.setTaskStatus(task.id, 'queued');
  const run = store.beginRun(task.id)!;
  assert.equal(run.agent_id, 'zcode'); assert.equal(run.model, 'provider/model');
  store.finishRun(run.id, { status: 'succeeded', session_id: 'zcode-session', exit_code: 0 }, 'done');
  assert.equal(runDetails(store.getRun(run.id)!, 'deepseek').agentId, 'zcode');
  assert.equal(store.lastSessionOfTask(task.id), 'zcode-session');
  assert.equal(store.addTask(project.id, 'future task').agent_id, 'deepseek');
});

test('project API validates Agent modes and protects active bindings while preserving historical task metadata', async t => {
  const dir = mkdtempSync(resolve('data', 'test-agent-api-'));
  const cfg = loadConfig({ configPath: join(dir, 'missing.json'), dataDir: dir });
  cfg.server.token = 'test-token';
  const store = new Store(dir);
  const app = buildServer({ cfg, store, docker: new Docker(), notifiers: [], scheduler: { tickNow() {} } as Scheduler });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = store.addProject('project', dir, 'zcode', 'capability', undefined, undefined, 'p/m');
  const headers = { 'x-agentdesk-token': cfg.server.token };
  const patch = (payload: object) => app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, payload, headers });
  assert.equal((await patch({ agent_id: 'unknown' })).statusCode, 400);
  assert.equal((await patch({ execution: 'isolation' })).statusCode, 400);
  assert.equal((await patch({ model: 'bare-model' })).statusCode, 400);
  const task = store.addTask(project.id, 'queued task');
  assert.equal((await patch({ agent_id: 'deepseek' })).statusCode, 409);
  assert.equal((await patch({ model: 'p/new-model' })).statusCode, 409);
  store.setTaskStatus(task.id, 'done');
  assert.equal((await patch({ agent_id: 'deepseek', model: 'deepseek-flash' })).statusCode, 200);
  const detail = (await app.inject({ url: `/api/tasks/${task.id}`, headers })).json();
  assert.equal(detail.agentId, 'zcode'); assert.equal(detail.task.model, 'p/m');
  assert.equal((await app.inject({ url: '/api/tasks', headers })).json().tasks[0].agent_id, 'zcode');
  assert.equal((await patch({ model: null })).json().project.model, null);
});

test('ZCode bridge selects the model per session and reports required input without answering for the user', async t => {
  const dir = mkdtempSync(resolve('data', 'test-zcode-bridge-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const glm = join(dir, 'resources', 'glm');
  const provider = join(dir, 'resources', 'config', 'provider');
  mkdirSync(glm, { recursive: true }); mkdirSync(provider, { recursive: true });
  writeFileSync(join(provider, 'zcode-builtin.json'), '{}');
  const personal = join(dir, 'provider_config.json'); writeFileSync(personal, '{}');
  const prior = Object.fromEntries(['ZCODE_BUILTIN_PROVIDER_CONFIG_FILE', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'].map(key => [key, process.env[key]]));
  delete process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personal;
  t.after(() => { for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const fake = join(glm, 'zcode.cjs');
  writeFileSync(fake, `
if (!process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || !process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE) { console.error('Missing provider runtime paths'); process.exit(1); }
const {createInterface}=require('node:readline');
const {writeFileSync}=require('node:fs');
const emit=o=>process.stdout.write(JSON.stringify(o)+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);if(!request.method)return;
 if(request.method==='session/create'){
  writeFileSync(${JSON.stringify(join(dir, 'selected.json'))},JSON.stringify(request.params.model));
  emit({id:request.id,result:{session:{sessionId:'sess-fixture'}}});return;
 }
 emit({id:request.id,result:{}});
 if(request.method==='session/send')emit({method:'session/event',params:{sessionId:'sess-fixture',type:'userInput.requested',payload:{prompt:'Which account should I use?'}}});
 if(request.method==='session/close')process.exit(0);
});`);
  const cfg = loadConfig({ configPath: join(dir, 'missing.json'), dataDir: dir, logDir: dir });
  cfg.agents.zcode!.executable = fake;
  const adapter = getAdapter('zcode', '', '');
  const prepared = prepareNativeAgent({ id: 'zcode', model: 'provider/model', cmd: adapter.buildArgs('original prompt'), cwd: dir, cfg, runId: 1 });
  try {
    const result = await runNative({ cmd: prepared.cmd, cwd: dir, env: prepared.env, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0, result.err.join('\n'));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'selected.json'), 'utf8')), { providerId: 'provider', modelId: 'model' });
    const events = result.out.map(line => adapter.parseLine(line)).filter(Boolean);
    assert.ok(events.some(event => event?.type === 'input_requested' && event.text === 'Which account should I use?'));
  } finally { prepared.cleanup(); }
});
