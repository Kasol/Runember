import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Docker from 'dockerode';
import { classifyRun, executionFailure, repeatedRunFailure, runDetails, taskView, taskStateLabel, type Run, type Task, type NotifyEvent } from '@agentdesk/core';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { buildServer } from '../src/server.js';
import type { Scheduler } from '../src/scheduler.js';
import { runtimeConfig } from '../src/agent-runtime.js';
import { readRuntimeConfig } from '../src/agent-settings.js';
import { networkSettings, validateNativeProxy, testNativeConnection } from '../src/network-settings.js';
import { hostCodexProxyEnv } from '../src/native.js';
import { ConnectionWatch } from '../src/connection-watch.js';
import { diagnoseTask, diagnoseStoredTask } from '../src/diagnostics.js';
import { buildEventMarkdown, runDetailsMarkdown } from '../src/dingtalk-markdown.js';
import { applyTaskAction } from '../src/actions.js';
import { DingTalkAppNotifier } from '../src/dingtalk-app.js';
import { getAdapter } from '@agentdesk/adapters';

const routing = 'workspace routing discovery failed';
const fakeRun = (id: number, message = routing): Run => ({ id, task_id: 1, kind: 'resume', status: 'failed', exit_code: 1,
  summary_json: JSON.stringify({ diagnostic: JSON.stringify({ type: 'error', message }) }) });

test('auth and quota classification require real error evidence and ignore opaque IDs', () => {
  for (const id of ['01a1f129-c49e-7371-bd82-6e2a9401102a', '01a14290-xxxx']) {
    assert.equal(executionFailure(`turn_id=${id} sampling_error=${routing}`)?.code, 'network_failed');
    assert.equal(executionFailure(`turn_id=${id}`), undefined);
  }
  for (const text of ['HTTP 401', 'HTTP/1.1 401 Unauthorized', 'status_code: 401', '{"status":401,"message":"request rejected"}', 'not logged in']) assert.equal(executionFailure(text)?.code, 'authentication_failed', text);
  for (const text of ['HTTP 429', 'statusCode=429', '{"error":{"status":429,"message":"request rejected"}}', 'rate limit exceeded']) assert.equal(executionFailure(text)?.code, 'rate_limited', text);
  const base = { exitCode: 1, killed: false, lastAgentText: '', errTail: 'optional MCP status: 401' };
  assert.equal(classifyRun({ ...base, primaryError: routing }).blockedKind, 'unknown_error');
  assert.equal(classifyRun({ ...base, primaryError: 'unknown model error' }).blockedKind, 'unknown_error');
  assert.equal(classifyRun({ ...base, primaryError: 'HTTP 401' }).blockedKind, 'auth_missing');
  assert.equal(classifyRun({ ...base, exitCode: 0 }).status, 'succeeded');
});

test('model stream progress clears transport warnings without exposing reasoning text', () => {
  const codex=getAdapter('codex','',''),deepseek=getAdapter('deepseek','','');
  for(const event of [codex.parseLine(JSON.stringify({type:'item.started',item:{id:'reasoning',type:'reasoning',text:'private reasoning'}})),deepseek.parseLine(JSON.stringify({type:'thinking',text:'private reasoning'}))]){
    assert.equal(event?.progress,true);assert.ok(!JSON.stringify(event).includes('private reasoning'));
  }
  assert.equal(codex.parseLine(JSON.stringify({type:'item.completed',item:{id:'error',type:'error',message:routing}}))?.type,'error');
});

test('primary routing failure outranks shutdown telemetry and legacy auth classification is not rewritten', async t => {
  const dir = mkdtempSync(resolve('data', 'test-route-diagnosis-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'run.jsonl');
  writeFileSync(log, '[stderr] MCP startup failed: HTTP 401\n[stderr] analytics connection failed\n');
  const run = { ...fakeRun(56), blocked_kind: 'auth_missing' as const, log_path: log };
  const task: Task = { id: 1, project_id: 1, prompt: 'private prompt', status: 'failed', created_at: '' };
  const report = await diagnoseTask(task, run);
  assert.equal(report.findings[0]?.code, 'network_failed');
  assert.ok(!report.findings.some(x => x.code === 'authentication_failed'));
  assert.equal(run.blocked_kind, 'auth_missing');
  assert.equal(runDetails(run).stage, '连接失败');
  assert.equal(runDetails(run).diagnostic, routing);
  assert.equal(repeatedRunFailure([fakeRun(55), run, fakeRun(57)])?.count, 3);
  assert.equal(repeatedRunFailure([fakeRun(55), { ...fakeRun(56), exit_code: 0, status: 'succeeded' }, fakeRun(57)]), undefined);
  assert.equal(repeatedRunFailure([fakeRun(55), fakeRun(56, 'ECONNREFUSED'), fakeRun(57)]), undefined);
});

test('connection watcher alerts once after sustained retries, preserves warning across restart and recovers on progress', () => {
  let now = 0; const changes: any[] = []; const notifications: string[] = [];
  const options = { now: () => now, changed: (s: any) => changes.push(s), notify: (kind: string) => notifications.push(kind) };
  const watch = new ConnectionWatch(options);
  for(const text of ['codex_models_manager: request timed out','MCP connection failed','analytics connection failed'])watch.stderr(text);
  now = 600000; watch.tick(); assert.equal(notifications.length, 0); // A long tool is not a network failure.
  assert.equal(changes.length,0);
  watch.error(routing);
  const since = changes.at(-1).since;
  for (let i = 0; i < 3; i++) { now += 30000; watch.error('stream disconnected'); watch.tick(); }
  assert.equal(changes.at(-1).since, since); assert.equal(notifications.length, 0);
  now += 30000; watch.tick(); watch.tick(); assert.deepEqual(notifications, ['run.connection_warning']);
  const recovered = new ConnectionWatch({ ...options, previous: changes.at(-1) });
  now += 600000; recovered.tick(); assert.equal(notifications.length, 1);
  recovered.progress(); recovered.progress(); assert.deepEqual(notifications, ['run.connection_warning', 'run.connection_recovered']);
  assert.equal(changes.at(-1).state, 'recovered');
  recovered.error(routing); now += 300000; recovered.tick(); assert.equal(notifications.length, 2);
  const current = { ...fakeRun(1), status: 'running' as const, exit_code: undefined, connection: changes.at(-1) };
  const task: Task = { id: 1, project_id: 1, prompt: '', status: 'running', created_at: '' };
  assert.match(taskStateLabel(taskView(task, current)), /运行中.*连接重试中/);
  assert.equal(runDetails(current).stage, '连接重试中');
});

test('proxy settings validate, persist, protect local access and affect next-run and offline diagnostics only', async t => {
  const dir = mkdtempSync(resolve('data', 'test-proxy-settings-'));
  const cfg = loadConfig({ configPath: join(dir, 'absent.json'), dataDir: dir, logDir: dir });
  cfg.proxy = { httpsProxy: 'http://container.invalid:7897', httpProxy: '', nativeHttpsProxy: '', nativeHttpProxy: '' };
  const store = new Store(dir); const scheduler = { tickNow() {} } as Scheduler;
  const app = buildServer({ cfg, store, docker: new Docker(), scheduler, notifiers: [] });
  t.after(async () => { await app.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const patch = (url: unknown, remoteAddress='127.0.0.1', origin?: string) => app.inject({ method:'PATCH', url:'/api/settings/network',payload:{url},remoteAddress,headers:origin?{origin}:{} });
  assert.equal((await patch('http://127.0.0.1:7897','192.0.2.1')).statusCode,403);
  assert.equal((await patch('http://127.0.0.1:7897','127.0.0.1','https://evil.invalid')).statusCode,403);
  for (const value of [null, {}, '127.0.0.1:7897', 'socks5://127.0.0.1:7897', 'http://user:password@localhost:1', 'http://localhost:1/path']) assert.equal((await patch(value)).statusCode,400);
  const saved=await patch('http://127.0.0.1:7897/'); assert.equal(saved.statusCode,200);
  assert.equal(saved.json().mode,'custom'); assert.equal(saved.json().httpsProxy,'http://127.0.0.1:7897');
  assert.equal(cfg.proxy.nativeHttpsProxy,''); assert.equal(cfg.proxy.httpsProxy,'http://container.invalid:7897');
  const runtime=runtimeConfig(cfg,store);assert.equal(runtime.proxy.nativeHttpsProxy,'http://127.0.0.1:7897');
  assert.ok(hostCodexProxyEnv(runtime.proxy).includes('HTTPS_PROXY=http://127.0.0.1:7897'));
  assert.ok(hostCodexProxyEnv(runtime.proxy).some(value=>value.startsWith('NO_PROXY=')&&value.includes('localhost')&&value.includes('127.0.0.1')));
  assert.equal(readRuntimeConfig(cfg).proxy.nativeHttpProxy,'http://127.0.0.1:7897');
  assert.equal((await patch('')).json().mode,'inherit');assert.equal(runtimeConfig(cfg,store).proxy.nativeHttpsProxy,'');
  const privateCfg={...cfg,proxy:{...cfg.proxy,nativeHttpsProxy:'http://user:private@127.0.0.1:7897'}};
  assert.ok(!JSON.stringify(networkSettings(privateCfg,store)).includes('private'));
  assert.equal(validateNativeProxy('http://[::1]:7897/'),'http://[::1]:7897');
});

test('connection test distinguishes transport reachability from authentication and proxy authentication', async () => {
  const cfg = loadConfig({ configPath: resolve('data/nonexistent-network-test.json') });
  cfg.proxy.nativeHttpsProxy = 'http://127.0.0.1:7897';
  let options: any; let args: string[] = [];
  const mock = async (_file: string, values: string[], opts: any) => { args=values;options=opts;return {stdout:'401\t0.125',stderr:''}; };
  const result=await testNativeConnection(cfg,mock as any);
  assert.equal(result.ok,true); assert.equal(result.httpStatus,401);assert.equal(result.elapsedMs,125);
  assert.ok(!args.some(x=>x.includes('7897')));assert.equal(options.env.HTTPS_PROXY,'http://127.0.0.1:7897');assert.equal(options.windowsHide,true);
  assert.equal((await testNativeConnection(cfg,(async()=>({stdout:'407\t0.02',stderr:''})) as any)).ok,false);
  assert.equal((await testNativeConnection(cfg,(async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'})}) as any)).ok,false);
});

test('connection observations and launch proxy survive reopening and stay independent of later settings', async t => {
  const dir=mkdtempSync(resolve('data','test-network-run-'));
  let store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  const cfg=loadConfig({configPath:join(dir,'absent.json'),dataDir:dir,logDir:dir});
  const project=store.addProject('fixture',dir,'codex'),task=store.addTask(project.id,'original');
  const run=store.beginRun(task.id)!;
  const connection={state:'retrying' as const,since:new Date(0).toISOString(),lastProgressAt:new Date(0).toISOString(),reason:'Agent 连接错误',warnedAt:new Date(120000).toISOString()};
  store.updateRun(run.id,{status:'running',connection,network:{httpsProxy:'http://127.0.0.1:7897'}});
  store.setSetting('network.nativeProxy','http://127.0.0.1:7898');store.close();store=new Store(dir);
  assert.equal(store.getRun(run.id)?.network?.httpsProxy,'http://127.0.0.1:7897');
  assert.deepEqual(store.getRun(run.id)?.connection,connection);
  assert.equal(runtimeConfig(cfg,store).proxy.nativeHttpsProxy,'http://127.0.0.1:7898');
  assert.equal((await diagnoseStoredTask(cfg,task.id)).findings[0]?.code,'connection_retrying');
});

test('status, continuation and connection notifications explain repeat failures without blocking user actions', async t => {
  const dir = mkdtempSync(resolve('data', 'test-repeat-network-'));const store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  const project=store.addProject('fixture',dir,'codex');const task=store.addTask(project.id,'original');
  for(let i=0;i<3;i++){const r=store.beginRun(task.id)!;store.finishRun(r.id,{status:'failed',exit_code:1,session_id:'original-session',summary_json:fakeRun(i).summary_json},'failed');if(i<2)store.setTaskStatus(task.id,'queued');}
  const scheduler={tickNow(){}} as Scheduler;
  const status=await applyTaskAction(store,scheduler,{type:'status',taskId:task.id},'dingtalk');assert.match(status.message,/连续 3 轮/);assert.match(status.message,/连接失败/);
  const resume=await applyTaskAction(store,scheduler,{type:'resume',taskId:task.id,feedback:'raw feedback'},'dingtalk');assert.equal(resume.ok,true);assert.match(resume.message,/连续 3 轮/);assert.equal(store.getTask(task.id)?.pending_feedback,'raw feedback');
  const connection={state:'retrying' as const,since:'2026-11-19T01:00:00Z',lastProgressAt:'2026-11-19T00:59:00Z',reason:'Agent 网络连接错误',warnedAt:'2026-11-19T01:02:00Z'};
  const event:NotifyEvent={kind:'run.connection_warning',runId:3,task,project,connection};
  const card=buildEventMarkdown(event,'');assert.match(card.title,/连接重试中/);assert.match(card.text,/执行器仍在运行/);
  assert.doesNotMatch(card.title,/已结束|等待确认/);
  assert.match(buildEventMarkdown({...event,kind:'run.connection_recovered'},'').title,/恢复活动/);
  assert.match(buildEventMarkdown(event,'',undefined,'en').title,/Reconnecting/);
  assert.match(runDetailsMarkdown({...runDetails(fakeRun(3)),connection},false),/停止前的连接重试/);
});

test('connection notifications follow failed subscriptions, deduplicate per Run and never publish a final report', async t => {
  const original=globalThis.fetch;const texts: string[]=[];let reports=0;
  globalThis.fetch=(async(input:any,options:any)=>{if(String(input).includes('accessToken'))return new Response(JSON.stringify({accessToken:'fixture-token',expireIn:7200}));texts.push(JSON.parse(JSON.parse(options.body).msgParam).text);return new Response(JSON.stringify({processQueryKey:'fixture'}));}) as typeof fetch;
  t.after(()=>{globalThis.fetch=original});
  const task:Task={id:1,project_id:1,prompt:'private prompt',status:'running',created_at:''};
  const project={id:1,name:'fixture',workspace_path:'fixture',agent_id:'codex',created_at:''};
  const connection={state:'retrying' as const,since:'2026-11-19T01:00:00Z',lastProgressAt:'2026-11-19T00:59:00Z',reason:'Agent 连接错误'};
  const event:NotifyEvent={kind:'run.connection_warning',runId:1,task,project,connection};
  const notifier=new DingTalkAppNotifier('id','secret','',['failed'],{conversationId:'fixture'},async()=>{reports++;return 'https://invalid.test/report'},()=> 'en');
  await notifier.notify(event);await notifier.notify(event);await notifier.notify({...event,kind:'run.connection_recovered'});await notifier.notify({...event,runId:2});
  assert.equal(texts.length,3);assert.equal(reports,0);assert.match(texts[0]!,/Reconnecting/);assert.ok(!texts[0]!.includes('Agent 连接错误'));
  await new DingTalkAppNotifier('id','secret','',['succeeded'],{conversationId:'fixture'}).notify({...event,runId:3});assert.equal(texts.length,3);
});
