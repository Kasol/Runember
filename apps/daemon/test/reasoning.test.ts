import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import Docker from 'dockerode';
import { parse as yaml } from 'yaml';
import { getAdapter } from '@agentdesk/adapters';
import { runDetails, runTiming } from '@agentdesk/core';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/server.js';
import { agentCatalog, reasoningCapabilities, validateReasoningEffort, zcodeReasoningOptions, prepareNativeAgent } from '../src/agent-runtime.js';
import { runNative } from '../src/native.js';
import type { Scheduler } from '../src/scheduler.js';

function fixture(t: TestContext) {
  const dir = mkdtempSync(resolve('data', 'test-reasoning-'));
  const keys = ['CODEX_HOME', 'DSH_HOME', 'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE', 'ZCODE_DATA_BASE_DIR'];
  const before = keys.map(key => process.env[key]);
  const disposers: Array<() => void | Promise<void>> = [];
  for (const key of keys) delete process.env[key];
  process.env.CODEX_HOME = join(dir, 'codex');
  process.env.DSH_HOME = join(dir, 'dsh');
  process.env.ZCODE_DATA_BASE_DIR = dir;
  mkdirSync(process.env.CODEX_HOME, { recursive: true });
  writeFileSync(join(process.env.CODEX_HOME, 'config.toml'), 'model="fixture-model"\nmodel_reasoning_effort="medium"\n');
  writeFileSync(join(process.env.CODEX_HOME, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'fixture-model', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }] },
    { slug: 'no-reasoning', supported_reasoning_levels: [] },
  ] }));
  const cfg = loadConfig({ configPath: join(dir, 'missing.json'), dataDir: dir, logDir: dir });
  cfg.server.token = 'fixture-token';
  t.after(async () => {
    for (const dispose of disposers) await dispose();
    for (const [i, key] of keys.entries()) { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; }
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, cfg, dispose: (fn: () => void | Promise<void>) => disposers.push(fn) };
}

test('reasoning capabilities preserve native model options and reject unknown overrides', t => {
  const { cfg } = fixture(t);
  assert.deepEqual(reasoningCapabilities(cfg, 'codex').options.map(x => x.id), ['low', 'high']);
  assert.deepEqual(reasoningCapabilities(cfg, 'codex', 'no-reasoning').options, []);
  assert.deepEqual(reasoningCapabilities(cfg, 'codex', 'custom-unknown').options, []);
  assert.equal(validateReasoningEffort(cfg, 'codex', null, 'high'), 'high');
  for (const value of ['', [], {}, 'high\nsecret', 'ultra']) assert.throws(() => validateReasoningEffort(cfg, 'codex', null, value));
  assert.equal(validateReasoningEffort(cfg, 'codex', null, null), null);
  const rules = { modelConfigRules: { modelRules: [
    { modelMatch: '.*', config: { optionSpecs: { reasoningLevel: { values: ['disabled', 'enabled'] } } } },
    { modelMatch: 'advanced', config: { optionSpecs: { reasoningLevel: { values: ['low', 'high', 'max'] } } } },
    { modelMatch: 'no-thinking', config: {} },
  ] } };
  assert.deepEqual(zcodeReasoningOptions(rules, 'advanced').map(x => x.id), ['low', 'high', 'max']);
  assert.deepEqual(zcodeReasoningOptions(rules, 'no-thinking'), []);
  assert.deepEqual(reasoningCapabilities(cfg, 'deepseek', 'deepseek-account/deepseek-flash').options.map(x => x.id), ['off', 'low', 'high', 'max']);
  assert.deepEqual(reasoningCapabilities(cfg, 'deepseek', 'custom-provider/model').options, []);
  assert.ok(agentCatalog(cfg).find(x => x.id === 'codex')?.models[0]?.reasoningOptions?.some(x => x.id === 'high'));
});

test('project API validates effort, resets it for a new model and pins drafts, retries and resumes', async t => {
  const { dir, cfg, dispose } = fixture(t);
  for (const args of [['init', '-q'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) execFileSync('git', args, { cwd: dir, windowsHide: true });
  const store = new Store(dir);
  const app = buildServer({ cfg, store, docker: new Docker(), notifiers: [], scheduler: { tickNow() {} } as Scheduler });
  dispose(async () => { await app.close(); store.close(); });
  const headers = { 'x-agentdesk-token': 'fixture-token' };
  const create = (effort: unknown) => app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'fixture', workspace_path: dir, model: 'fixture-model', reasoning_effort: effort } });
  assert.equal((await create('medium')).statusCode, 400);
  const created = await create('high');
  assert.equal(created.statusCode, 201, created.body);
  const project = created.json().project;
  const patch = (body: object) => app.inject({ method: 'PATCH', url: `/api/projects/${project.id}`, headers, payload: body });
  const task = store.addTask(project.id, 'original prompt', { draft: true });
  assert.equal(task.reasoning_effort, 'high');
  assert.equal((await patch({ reasoning_effort: 'low' })).statusCode, 200);
  store.setTaskStatus(task.id, 'queued');
  assert.equal((await patch({ reasoning_effort: null })).statusCode, 409);
  const first = store.beginRun(task.id)!;
  assert.equal(first.reasoning_effort, 'high');
  store.finishRun(first.id, { status: 'succeeded', exit_code: 0, session_id: 'fixture-session' }, 'done');
  assert.equal((await patch({ model: 'no-reasoning', reasoning_effort: 'high' })).statusCode, 400);
  assert.equal((await patch({ model: 'no-reasoning' })).json().project.reasoning_effort, null);
  store.setPendingFeedback(task.id, 'continue raw'); store.setTaskStatus(task.id, 'queued');
  const resumed = store.beginRun(task.id)!;
  assert.equal(resumed.kind, 'resume'); assert.equal(resumed.reasoning_effort, 'high');
  store.finishRun(resumed.id, { status: 'succeeded', exit_code: 0 }, 'done');
  store.setTaskStatus(task.id, 'queued');
  const retried = store.beginRun(task.id)!;
  assert.equal(retried.kind, 'normal'); assert.equal(retried.reasoning_effort, 'high');
  const details = runDetails(retried, 'codex');
  assert.equal(details.reasoningEffort, 'high'); assert.match(runTiming(details), /推理：高/);
  const capabilities = (await app.inject({ url: '/api/agents/codex/reasoning?model=fixture-model', headers })).json();
  assert.deepEqual(capabilities.options.map((x: any) => x.id), ['low', 'high']);
  const next = store.addTask(project.id, 'new prompt', { draft: true });
  assert.equal(next.reasoning_effort, null);
  assert.equal((await patch({ reasoning_effort: {} })).statusCode, 409);
});

test('old databases add nullable effort columns without assigning project values to old tasks', t => {
  const { dir, dispose } = fixture(t);
  let store = new Store(dir);
  const project = store.addProject('legacy', dir, 'codex');
  const task = store.addTask(project.id, 'legacy prompt');
  const run = store.beginRun(task.id)!;
  store.finishRun(run.id, { status: 'succeeded', session_id: 'legacy-session', exit_code: 0 }, 'done');
  store.close();
  const db = new DatabaseSync(join(dir, 'agentdesk.db'));
  for (const table of ['projects', 'tasks', 'runs']) db.exec(`ALTER TABLE ${table} DROP COLUMN reasoning_effort`);
  db.close();
  store = new Store(dir); dispose(() => store.close());
  store.updateProject(project.id, { reasoning_effort: 'high' });
  assert.equal(store.getTask(task.id)?.reasoning_effort, null);
  assert.equal(store.getRun(run.id)?.reasoning_effort, null);
  assert.equal(store.lastSessionOfTask(task.id), 'legacy-session');
  assert.equal(store.addTask(project.id, 'new draft', { draft: true }).reasoning_effort, 'high');
});

test('native effort overrides reach Codex args and DeepSeek patches without changing global defaults', t => {
  const { dir, cfg } = fixture(t);
  const codex = getAdapter('codex', '', '');
  for (const args of [codex.buildArgs('raw prompt', 'capability', undefined, 'fixture-model', 'high'), codex.buildResumeArgs('session', 'raw feedback', 'capability', undefined, 'fixture-model', 'low')]) {
    assert.match(args[args.indexOf('-c') + 1]!, /^model_reasoning_effort="(?:high|low)"$/);
    assert.ok(['raw prompt', 'raw feedback'].includes(args.at(-1)!));
  }
  assert.ok(!codex.buildArgs('raw prompt').includes('-c'));
  const fake = join(dir, 'deepseek.cjs'); writeFileSync(fake, ''); cfg.agents.deepseek!.executable = fake;
  const home = process.env.DSH_HOME!;
  mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true });
  const global = join(home, 'profiles', 'desktop', 'cordis.patch.yml');
  const original = '- id: agent-default-model\n  config:\n    provider: deepseek-account\n    model: deepseek-flash\n    reasoningEffort: high\n';
  writeFileSync(global, original);
  for (const effort of ['low', null]) {
    const prepared = prepareNativeAgent({ id: 'deepseek', model: 'deepseek-account/deepseek-flash', reasoningEffort: effort, cmd: getAdapter('deepseek', '', '').buildArgs('raw prompt'), cwd: dir, cfg, runId: 1 });
    const file = prepared.cmd[prepared.cmd.indexOf('--patch') + 1]!;
    const entries = yaml(readFileSync(file, 'utf8'));
    assert.equal(entries.find((x: any) => x.id === 'agent-default-model').config.reasoningEffort, effort ?? 'high');
    assert.equal(prepared.cmd.at(-1), 'raw prompt');
    prepared.cleanup(); assert.ok(!existsSync(file));
    assert.equal(readFileSync(global, 'utf8'), original);
  }
});

test('ZCode uses only the requested effort on create and resumed sends, with no implicit high setting', async t => {
  const { dir, cfg } = fixture(t);
  const fake = join(dir, 'zcode.cjs'), selected = join(dir, 'selected.json');
  const builtin = join(dir, 'builtin.json'), personal = join(dir, 'personal.json');
  writeFileSync(builtin, JSON.stringify({ config: { modelConfigRules: { modelRules: [{ modelMatch: 'model', config: { optionSpecs: { reasoningLevel: { values: ['low', 'high'] } } } }] } } }));
  writeFileSync(personal, '{}'); process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin; process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = personal;
  cfg.agents.zcode!.executable = fake;
  writeFileSync(fake, `const {createInterface}=require('node:readline');const fs=require('node:fs');const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');createInterface({input:process.stdin}).on('line',l=>{const x=JSON.parse(l);if(!x.method)return; if(x.method==='session/send'){fs.writeFileSync(${JSON.stringify(selected)},JSON.stringify(x.params));emit({id:x.id,result:{}});emit({method:'session/event',params:{sessionId:'fixture',type:'turn.completed',payload:{response:'ok'}}});return;}emit({id:x.id,result:x.method==='session/create'?{sessionId:'fixture'}:{}});if(x.method==='session/close')process.exit(0);});`);
  const adapter = getAdapter('zcode', '', '');
  for (const [effort, resume] of [[null, false], ['high', false], ['low', true]] as const) {
    const cmd = resume ? adapter.buildResumeArgs('fixture', 'raw feedback') : adapter.buildArgs('raw prompt');
    const prepared = prepareNativeAgent({ id: 'zcode', model: 'provider/model', reasoningEffort: effort, cmd, cwd: dir, cfg, runId: 1 });
    try {
      const result = await runNative({ cmd: prepared.cmd, cwd: dir, env: prepared.env, timeoutMs: 10000 });
      assert.equal(result.exitCode, 0, result.err.join('\n'));
      const sent = JSON.parse(readFileSync(selected, 'utf8'));
      assert.equal(sent.content, resume ? 'raw feedback' : 'raw prompt');
      assert.deepEqual(sent.modelSelection, { providerId: 'provider', modelId: 'model', ...(effort ? { options: { reasoningLevel: effort } } : {}) });
    } finally { prepared.cleanup(); }
  }
});
