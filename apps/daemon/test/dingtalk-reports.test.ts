import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runDetails, type NotifyEvent } from '@agentdesk/core';
import { DingTalkAppNotifier } from '../src/dingtalk-app.js';
import { DingTalkReports, ReportError, reportLogChunks } from '../src/dingtalk-reports.js';
import { EventBus } from '../src/notify.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';

test('report environment configuration reaches the optional publisher', t => {
  const values = {
    AGENTDESK_NOTIFY__DINGTALKREPORT__EXECUTABLE: 'fixture.exe',
    AGENTDESK_NOTIFY__DINGTALKREPORT__CONFIGDIR: 'fixture-auth',
    AGENTDESK_NOTIFY__DINGTALKREPORT__PROFILE: 'fixture:account',
  };
  const before = Object.keys(values).map(key => [key, process.env[key]] as const);
  t.after(() => { for (const [key, value] of before) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  } });
  Object.assign(process.env, values);
  const config = loadConfig({ configPath: join(tmpdir(), 'nonexistent-report-fixture.json') });
  assert.equal(config.notify.dingtalkReport?.executable, 'fixture.exe');
  assert.equal(config.notify.dingtalkReport?.configDir, 'fixture-auth');
  assert.equal(config.notify.dingtalkReport?.profile, 'fixture:account');
});

test('a report retains the full Run log and reuses its document across retries and restart', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-report-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = store.addProject('report fixture', dir, 'codex');
  const task = store.addTask(project.id, 'line one\n  line two');
  const run = store.beginRun(task.id)!;
  const logPath = join(dir, 'run.jsonl');
  const fullLog = 'first line\n' + '中文🙂 logs\n'.repeat(5000) + '~~~text\nlast line';
  writeFileSync(logPath, fullLog);
  store.finishRun(run.id, { status: 'succeeded', exit_code: 0, log_path: logPath,
    summary_json: JSON.stringify({ agentMessage: 'final answer', filesChanged: [], diffStat: '' }) }, 'done');
  const event: NotifyEvent = { kind: 'run.succeeded', runId: run.id,
    task: store.getTask(task.id)!, project,
    summary: { agentMessage: 'final answer', filesChanged: [], diffStat: '' },
    details: runDetails(store.getRun(run.id)!, 'codex'),
  };
  const config = { executable: 'fixture', configDir: join(dir, 'auth') };
  const url = 'https://alidocs.dingtalk.com/i/nodes/fixture';
  const publisher = new DingTalkReports(config, store, dir, { retryDelaysMs: [1, 1, 1] });
  const calls: string[] = [];
  let report = '';
  let valid = false;
  let native: unknown = [];
  const invoke = async (args: string[]) => {
    calls.push(args[1]!);
    if (args[1] === 'create') return { success: true, nodeId: 'fixture', docUrl: url };
    if (args[1] === 'update') {
      const content = readFileSync(args[args.indexOf('--content-file') + 1]!, 'utf8');
      if (args.includes('jsonml')) { assert.ok(args.includes('7')); native = JSON.parse(content); }
      else {
        report = content;
        native = ['root', {}, ['h2', {}, ['span', {}, '完整 Run 日志']],
          ...reportLogChunks(fullLog).map(chunk => ['code', { code: chunk + ' EXTRA WHITESPACE' }])];
      }
      return { success: true };
    }
    if (args.includes('jsonml')) return { jsonml: native, revision: 7 };
    return { success: true, markdown: valid ? report : 'incomplete' };
  };
  t.mock.method(publisher as unknown as { call: typeof invoke }, 'call', invoke);
  const first = publisher.publish(event);
  assert.equal(publisher.publish(event), first);
  await assert.rejects(first, /完整性检查/);
  for (const chunk of reportLogChunks(fullLog)) assert.ok(report.includes(chunk));
  assert.ok(report.includes(task.prompt));
  valid = true;
  assert.equal(await publisher.publish(event), url);
  assert.equal(calls.filter(x => x === 'create').length, 1);
  assert.equal(calls.filter(x => x === 'update').length, 2); // One Markdown write and one native log repair.
  const restarted = new DingTalkReports(config, store, dir);
  assert.equal(await restarted.publish(event), url);
});

test('notification sends the detail button after publishing and still delivers if publishing fails', async t => {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    requests.push({ url, body });
    return Response.json(url.includes('accessToken') ? { accessToken: 'fixture', expireIn: 3600 }
      : { processQueryKey: 'sent' });
  });
  const event: NotifyEvent = { kind: 'run.succeeded', runId: 1,
    task: { id: 1, project_id: 1, status: 'done', prompt: 'read-only test', created_at: '' },
    project: { id: 1, name: 'fixture', workspace_path: '', agent_id: 'codex', created_at: '' },
    summary: { agentMessage: 'answer', filesChanged: [], diffStat: '' },
  };
  const url = 'https://alidocs.dingtalk.com/i/nodes/fixture';
  const notifier = new DingTalkAppNotifier('fixture', 'fixture', '', ['succeeded'],
    { conversationId: 'fixture' }, async () => url);
  await notifier.notify(event);
  const body = requests.at(-1)!.body;
  assert.equal(body.msgKey, 'sampleMarkdown');
  const payload = JSON.parse(body.msgParam as string);
  assert.equal(payload.singleTitle, undefined);
  assert.ok(payload.text.endsWith('[📄 查看详情](' + url + ')'));
  assert.equal(payload.singleURL, undefined);
  assert.ok(payload.text.includes('answer'));
  assert.doesNotMatch(payload.text, /配置 server.publicUrl/);

  const fallback = new DingTalkAppNotifier('fixture', 'fixture', '', ['succeeded'],
    { conversationId: 'fixture' }, async () => { throw Error('auth fixture'); });
  await fallback.notify({ ...event, runId: 2 });
  assert.equal(requests.at(-1)!.body.msgKey, 'sampleMarkdown');
  assert.match(JSON.parse(requests.at(-1)!.body.msgParam as string).text, /详情报告暂不可用/);

  const english = new DingTalkAppNotifier('fixture', 'fixture', '', ['succeeded'],
    { conversationId: 'fixture' }, async (_event, language) => { assert.equal(language, 'en'); return url; }, () => 'en');
  await english.notify({ ...event, runId: 3 });
  const englishPayload = JSON.parse(requests.at(-1)!.body.msgParam as string);
  assert.ok(englishPayload.text.endsWith('[📄 View details](' + url + ')'));
  assert.equal(englishPayload.title, '⏹ Ended · Stopped');
  assert.doesNotMatch(englishPayload.text, /[\u4e00-\u9fff]/);
});

test('daemon shutdown drains report notifications before closing the store', async () => {
  let delivered = false;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const bus = new EventBus([{ name: 'report fixture', async notify() { await pending; delivered = true; } }]);
  bus.emit({ kind: 'run.started', runId: 1,
    task: { id: 1, project_id: 1, status: 'running', prompt: '', created_at: '' },
    project: { id: 1, name: '', workspace_path: '', agent_id: 'codex', created_at: '' },
  });
  const draining = bus.drain();
  assert.equal(delivered, false);
  release();
  await draining;
  assert.equal(delivered, true);
});

test('long physical log lines split losslessly without breaking Unicode or CRLF', () => {
  const log = 'x'.repeat(5999) + '🙂' + 'line'.repeat(19000) + '\r\nlast\n';
  const chunks = reportLogChunks(log);
  assert.equal(chunks.join(''), log);
  assert.ok(chunks.every(chunk => chunk.length <= 6000 && !/[\uD800-\uDBFF]$/.test(chunk)));
});

test('transient document reads are retried before the one final notification is sent', async t => {
  const dir=mkdtempSync(join(tmpdir(),'report-read-retry-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  const project=store.addProject('fixture',dir,'codex'),task=store.addTask(project.id,'original prompt'),run=store.beginRun(task.id)!;
  const log=join(dir,'run.log');writeFileSync(log,'full log\n');
  store.finishRun(run.id,{status:'succeeded',exit_code:0,log_path:log,summary_json:JSON.stringify({agentMessage:'full answer',filesChanged:[],diffStat:''})},'done');
  const event:NotifyEvent={kind:'run.succeeded',runId:run.id,task:store.getTask(task.id)!,project,summary:{filesChanged:[],diffStat:''}};
  const report=new DingTalkReports({executable:'fixture',configDir:dir},store,dir,{retryDelaysMs:[1,1]});
  let markdown='',reads=0,creates=0,writes=0;const messages:string[]=[];
  t.mock.method(report as any,'call',async(args:string[])=>{
    if(args[1]==='create'){creates++;return {success:true,nodeId:'fixture',docUrl:'https://alidocs.dingtalk.com/i/nodes/fixture'}}
    if(args[1]==='update'){writes++;markdown=readFileSync(args[args.indexOf('--content-file')+1]!,'utf8');return {success:true}}
    if(args.includes('jsonml'))return {jsonml:['root',{},['h2',{},['span',{},'完整 Run 日志']],['code',{code:'full log\n'}]],revision:1};
    reads++;if(reads===1)throw new ReportError('doc read api/business_error');return {success:true,markdown};
  });
  t.mock.method(globalThis,'fetch',async(input:any,options:any)=>{
    if(String(input).includes('accessToken'))return Response.json({accessToken:'fixture',expireIn:3600});
    messages.push(JSON.parse(JSON.parse(options.body).msgParam).text);return Response.json({processQueryKey:'fixture'});
  });
  const notifier=new DingTalkAppNotifier('id','secret','',['succeeded'],{conversationId:'fixture'},report.publish);
  await notifier.notify(event);
  assert.equal(reads,2);assert.equal(creates,1);assert.equal(writes,1);assert.equal(messages.length,1);
  assert.match(messages[0]!,/查看详情/);assert.doesNotMatch(messages[0]!,/暂不可用/);
});

test('an ambiguous create is never blindly repeated after restart', async t => {
  const dir=mkdtempSync(join(tmpdir(),'report-create-ambiguous-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  const project=store.addProject('fixture',dir,'codex'),task=store.addTask(project.id,'prompt'),run=store.beginRun(task.id)!;
  store.finishRun(run.id,{status:'succeeded',exit_code:0,summary_json:JSON.stringify({filesChanged:[],diffStat:''})},'done');
  const event:NotifyEvent={kind:'run.succeeded',runId:run.id,task:store.getTask(task.id)!,project,summary:{filesChanged:[],diffStat:''}};
  const config={executable:'fixture',configDir:dir};let creates=0;
  const first=new DingTalkReports(config,store,dir);
  t.mock.method(first as any,'call',async()=>{creates++;throw Error('Connection lost after create request')});
  await assert.rejects(first.publish(event));
  const restored=new DingTalkReports(config,store,dir);
  t.mock.method(restored as any,'call',async()=>{creates++;throw Error('Must not create again')});
  await assert.rejects(restored.publish(event),/创建结果尚未核实/);assert.equal(creates,1);
});
