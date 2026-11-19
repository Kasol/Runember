import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NotifyEvent } from '@agentdesk/core';
import { Store } from '../src/store.js';
import { ReportDelivery } from '../src/report-delivery.js';
import { reportReadyMarkdown } from '../src/dingtalk-markdown.js';
import Docker from 'dockerode';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import type { Scheduler } from '../src/scheduler.js';

const event: NotifyEvent = { kind:'run.succeeded', runId:1,
  task:{id:1,project_id:1,prompt:'original prompt',status:'done',created_at:''},
  project:{id:1,name:'fixture',workspace_path:'fixture',agent_id:'codex',created_at:''},
  summary:{filesChanged:[],diffStat:'',agentMessage:'answer'},
};
const url='https://alidocs.dingtalk.com/i/nodes/fixture';

test('normal delivery waits for verification and sends one result with a button', async () => {
  let release!: (value:string)=>void;const report=new Promise<string>(r=>{release=r});const sent:any[]=[];
  const queue=new ReportDelivery({identity:'fixture',publish:async()=>report,result:async(...args)=>{sent.push(args)},link:async()=>{throw Error('unexpected link')}});
  const first=queue.deliver(event,'en');const duplicate=queue.deliver(event,'en');
  assert.equal(sent.length,0);release(url);await Promise.all([first,duplicate]);
  assert.equal(sent.length,1);assert.equal(sent[0][2],url);assert.equal(sent[0][1],'en');
  await queue.deliver(event,'en');assert.equal(sent.length,1);
});

test('deadline fallback, restart and recovery preserve language and supplement only once', async t => {
  const dir=mkdtempSync(resolve('data','test-report-delivery-'));let store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  let now=0;const results:any[]=[];const links:any[]=[];
  const first=new ReportDelivery({storage:store,identity:['channel','one'],now:()=>now,waitMs:10,retryMs:5,
    publish:()=>new Promise(()=>{}),result:async(...args)=>{results.push(args)},link:async(...args)=>{links.push(args)}});
  await first.deliver(event,'en');assert.equal(results.length,1);assert.equal(results[0][3],true);assert.equal(links.length,0);
  store.close();store=new Store(dir);now=100;
  const restored=new ReportDelivery({storage:store,identity:['channel','one'],now:()=>now,waitMs:20,retryMs:5,
    publish:async()=>url,result:async(...args)=>{results.push(args)},link:async(...args)=>{links.push(args)}});
  await restored.sweep();await restored.drain();assert.equal(results.length,1);assert.equal(links.length,1);assert.equal(links[0][1],'en');assert.equal(links[0][2],url);
  await restored.deliver(event,'zh-CN');await restored.sweep();await restored.drain();assert.equal(links.length,1);
  assert.equal(store.reportDeliveries(1)[0]?.state,'complete');
  assert.equal(JSON.parse(store.listDeliveries('')[0]!.payload).event,undefined);
});

test('failed message transport retries its original phase instead of losing the result or replaying Agent work', async t => {
  const dir=mkdtempSync(resolve('data','test-report-send-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  let calls=0,publishes=0,now=0;
  const queue=new ReportDelivery({storage:store,identity:'transport',now:()=>now,retryMs:1,publish:async()=>{publishes++;return url},
    result:async()=>{calls++;if(calls===1)throw Error('network failed')},link:async()=>{throw Error('unexpected link')}});
  await assert.rejects(queue.deliver(event,'zh-CN'),/network failed/);now=10;await queue.sweep();await queue.drain();
  assert.equal(calls,2);assert.equal(publishes,1);assert.equal(store.reportDeliveries(1)[0]?.state,'complete');
});

test('a failed supplementary message retries only its saved link and never repeats the result', async t => {
  const dir=mkdtempSync(resolve('data','test-report-link-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  let now=0,ready=false,publishes=0,results=0,links=0;
  const queue=new ReportDelivery({storage:store,identity:'link-transport',now:()=>now,retryMs:1,
    publish:async()=>{publishes++;if(!ready)throw Error('unavailable');return url},
    result:async()=>{results++},link:async()=>{links++;if(links===1)throw Error('send failed')}});
  await queue.deliver(event,'en');ready=true;now=10;await queue.sweep();await queue.drain();
  assert.equal(store.reportDeliveries(1)[0]?.state,'fallback');
  now=20;await queue.sweep();await queue.drain();
  assert.equal(results,1);assert.equal(publishes,2);assert.equal(links,2);assert.equal(store.reportDeliveries(1)[0]?.state,'complete');
});

test('background expiry, explicit report-only retry and subscriptions do not alter task execution', async t => {
  const dir=mkdtempSync(resolve('data','test-report-expiry-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  let now=0,ready=false,accepted=true;const sent:string[]=[];
  const queue=new ReportDelivery({storage:store,identity:'expiry',now:()=>now,lifetimeMs:20,retryMs:1,
    accept:()=>accepted,publish:async()=>{if(!ready)throw Error('permission');return url},
    result:async()=>{sent.push('fallback')},link:async()=>{sent.push('link')}});
  await queue.deliver(event,'zh-CN');accepted=false;now=5;await queue.sweep();await queue.drain();assert.deepEqual(sent,['fallback']);
  accepted=true;now=30;await queue.sweep();await queue.drain();assert.equal(store.reportDeliveries(1)[0]?.state,'expired');
  ready=true;assert.equal(queue.retry(1),1);await queue.drain();assert.deepEqual(sent,['fallback','link']);
  assert.equal(queue.retry(1),0);assert.equal(store.getTask(1),undefined); // No task or Run is created by report retries.
  const english=reportReadyMarkdown(event,'en');assert.doesNotMatch(english.text,/[\u4e00-\u9fff]/);assert.match(english.title,/report ready/);
});

test('report retry API checks authorization and Run ownership without changing Agent execution', async t => {
  const dir=mkdtempSync(resolve('data','test-report-api-'));const store=new Store(dir);
  const cfg=loadConfig({configPath:resolve(dir,'absent.json'),dataDir:dir,logDir:dir});
  const project=store.addProject('fixture',dir,'codex');
  const first=store.addTask(project.id,'original'),other=store.addTask(project.id,'other');
  const run=store.beginRun(first.id)!,otherRun=store.beginRun(other.id)!;
  store.finishRun(run.id,{status:'succeeded',exit_code:0},'done');
  const before={task:store.getTask(first.id),runs:store.runsOfTask(first.id)};const retried:number[]=[];
  const app=buildServer({cfg,store,docker:new Docker(),scheduler:{tickNow(){throw Error('Agent must not be scheduled')}} as unknown as Scheduler,
    notifiers:[{name:'fixture',notify:async()=>{},retryReport:id=>{retried.push(id);return 1}}]});
  t.after(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true})});
  const request=(runId:unknown,headers:Record<string,string>={},remoteAddress='127.0.0.1')=>app.inject({method:'POST',url:`/api/tasks/${first.id}/report/retry`,headers,remoteAddress,payload:{runId}});
  cfg.server.token='fixture';assert.equal((await request(run.id)).statusCode,401);
  assert.equal((await request(otherRun.id,{'x-agentdesk-token':'fixture'})).statusCode,404);
  assert.equal((await request('1',{'x-agentdesk-token':'fixture'})).statusCode,400);
  cfg.server.token='';assert.equal((await request(run.id,{},'192.0.2.1')).statusCode,403);
  assert.equal((await request(run.id,{origin:'https://external.invalid'})).statusCode,403);
  const response=await request(run.id);assert.equal(response.statusCode,200);assert.equal(response.json().scheduled,1);
  assert.deepEqual(retried,[run.id]);assert.deepEqual({task:store.getTask(first.id),runs:store.runsOfTask(first.id)},before);
});
