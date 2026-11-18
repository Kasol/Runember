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
import { groupDoctorChecks } from '../src/doctor.js';
import { execFileSync } from 'node:child_process';

test('environment checks group versions and login, while preserving failures without a separate provider row', () => {
  const rows = groupDoctorChecks([
    { name:'宿主 Codex CLI', tool:'codex', path:'/tools/codex', ok:true, required:true, detail:'/tools/codex' },
    { name:'Codex 版本', tool:'codex', part:'version', ok:true, required:false, detail:'codex-cli 1.2.3' },
    { name:'Codex 登录', tool:'codex', part:'login', ok:false, required:true, detail:'需要登录' },
    { name:'ZCode CLI', tool:'zcode', path:'/tools/zcode.cjs', ok:true, required:false, detail:'/tools/zcode.cjs' },
    { name:'ZCode 供应商配置', tool:'zcode', part:'configuration', ok:false, required:false, detail:'供应商配置缺失' },
  ]);
  assert.equal(rows.length,2);
  assert.equal(rows[0]!.version,'codex-cli 1.2.3');assert.equal(rows[0]!.path,'/tools/codex');
  assert.equal(rows[0]!.status,'登录未通过');assert.equal(rows[0]!.ok,false);assert.equal(rows[0]!.required,true);
  assert.equal(rows[1]!.ok,false);assert.equal(rows[1]!.required,false);assert.match(rows[1]!.detail,/配置缺失/);
  assert.ok(!rows.some(row=>row.name.includes('供应商')));
  const passed=groupDoctorChecks([{ name:'ZCode CLI', tool:'zcode', ok:true, required:true, detail:'可用' },
    { name:'ZCode 供应商配置', tool:'zcode', part:'configuration', ok:true, required:true, detail:'配置已找到' }]);
  assert.equal(passed.length,1);assert.equal(passed[0]!.ok,true);assert.equal(passed[0]!.detail,'可用');
});

test('project recheck reports the effective Agent path and version, and returns only one workspace row', async t => {
  const dir=mkdtempSync(resolve('data','test-project-checks-'));
  const cfg=loadConfig({configPath:join(dir,'absent.json'),dataDir:dir,logDir:dir});cfg.server.token='fixture';
  const first=join(dir,'first.cjs'),selected=join(dir,'selected.cjs');
  writeFileSync(first,'');writeFileSync(selected,'');writeFileSync(join(dir,'package.json'),JSON.stringify({name:'zcode-fixture',version:'1.2.3'}));
  for(const args of [['init','-q'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid']])execFileSync('git',args,{cwd:dir,windowsHide:true});
  cfg.agents.zcode!.executable=first;
  const store=new Store(dir);store.setSetting('agents.zcode.executable',selected);
  const project=store.addProject('fixture',dir,'zcode');
  const app=buildServer({cfg,store,docker:new Docker(),notifiers:[],scheduler:{tickNow(){}} as Scheduler});
  t.after(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const result=await app.inject({method:'POST',url:`/api/projects/${project.id}/recheck`,headers:{'x-agentdesk-token':'fixture'},payload:{}});
  assert.equal(result.statusCode,200);
  const rows=result.json().report;
  const agent=rows.find((row:any)=>row.tool==='zcode');
  assert.equal(agent.path,selected);assert.equal(agent.version,'1.2.3');assert.equal(agent.ok,true);
  assert.equal(rows.filter((row:any)=>row.name==='Git 工作区').length,1);
  assert.ok(!rows.some((row:any)=>row.name==='项目目录'||row.tool==='codex'||row.tool==='deepseek'));
});

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
