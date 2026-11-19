import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import Docker from 'dockerode';
import { MAX_TASK_TIMEOUT_MIN, validateTaskTimeout, runLimitLabel, runDetails, taskView, taskStateLabel, type RunConnection } from '@agentdesk/core';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import type { Scheduler } from '../src/scheduler.js';
import { ConnectionWatch } from '../src/connection-watch.js';
import { runManagedNative, nativeExecution } from '../src/managed-native.js';
import { buildEventMarkdown } from '../src/dingtalk-markdown.js';
import { applyTaskAction } from '../src/actions.js';
import { parseCommand } from '../src/dingtalk-stream.js';
import { Runner } from '../src/runner.js';
import { EventBus } from '../src/notify.js';
import { DingTalkAppNotifier } from '../src/dingtalk-app.js';
import { setImmediate } from 'node:timers/promises';
import { runNative } from '../src/native.js';

test('limits are optional, validated at creation, kept with drafts and snapshotted for every Run', async t=>{
  const dir=mkdtempSync(resolve('data','test-limits-api-')),store=new Store(dir),cfg=loadConfig({configPath:join(dir,'absent.json'),dataDir:dir,logDir:dir});
  cfg.scheduler.taskTimeoutMin=30;const p=store.addProject('fixture',dir,'codex');
  const app=buildServer({cfg,store,docker:new Docker(),notifiers:[],scheduler:{tickNow(){}} as Scheduler});
  t.after(async()=>{await app.close();store.close();rmSync(dir,{recursive:true,force:true})});
  const create=(limit?:unknown)=>app.inject({method:'POST',url:'/api/tasks',payload:{project:p.id,prompt:'original\n  prompt',draft:true,...(limit===undefined?{}:{timeout_min:limit})}});
  const unlimited=(await create()).json().task;assert.equal(unlimited.timeout_min,null);
  assert.equal((await create(0)).json().task.timeout_min,null);
  for(const limit of [-1,1.5,'30',true,MAX_TASK_TIMEOUT_MIN+1])assert.equal((await create(limit)).statusCode,400);
  const limited=(await create(120)).json().task;assert.equal(limited.prompt,'original\n  prompt');assert.equal(limited.timeout_min,120);
  assert.equal((await app.inject({method:'POST',url:`/api/tasks/${limited.id}/draft`,payload:{op:'enqueue'}})).statusCode,200);
  const first=store.beginRun(limited.id)!;assert.deepEqual(first.limits,{timeoutMin:120});
  store.updateTaskPrompt(limited.id,'original\n  prompt',null);assert.deepEqual(store.getRun(first.id)!.limits,{timeoutMin:120});
  store.finishRun(first.id,{status:'succeeded',exit_code:0,session_id:'existing'},'done');
  await applyTaskAction(store,{tickNow(){}} as Scheduler,{type:'resume',taskId:limited.id,feedback:'original feedback'});
  const next=store.beginRun(limited.id)!;assert.deepEqual(next.limits,{timeoutMin:null});assert.equal(next.kind,'resume');
  store.setTaskStatus(unlimited.id,'queued');assert.deepEqual(store.beginRun(unlimited.id)!.limits,{timeoutMin:null});
  assert.equal(validateTaskTimeout(undefined),null);assert.equal(validateTaskTimeout(null),null);assert.equal(validateTaskTimeout(MAX_TASK_TIMEOUT_MIN),MAX_TASK_TIMEOUT_MIN);
  assert.equal(runLimitLabel({timeoutMin:1},'en'),'Run time limit: 1 minute');
});

test('old databases preserve history and legacy global limits do not become task defaults', t=>{
  const dir=mkdtempSync(resolve('data','test-limits-upgrade-'));let store=new Store(dir);
  const p=store.addProject('fixture',dir,'codex'),task=store.addTask(p.id,'history'),old=store.beginRun(task.id)!;
  const summary=JSON.stringify({agentMessage:'old progress'});store.finishRun(old.id,{status:'blocked',blocked_kind:'timeout',summary_json:summary},'blocked');store.close();
  const db=new DatabaseSync(join(dir,'agentdesk.db'));db.exec('ALTER TABLE tasks DROP COLUMN timeout_min; ALTER TABLE runs DROP COLUMN limits_json;');db.close();
  store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  assert.equal(store.getRun(old.id)?.limits,undefined);assert.equal(store.getRun(old.id)?.summary_json,summary);assert.equal(store.getRun(old.id)?.blocked_kind,'timeout');
  store.setTaskStatus(task.id,'queued');assert.deepEqual(store.beginRun(task.id)?.limits,{timeoutMin:null});
});

test('DingTalk accepts an explicit leading time-limit option and preserves description content', async t=>{
  const dir=mkdtempSync(resolve('data','test-limits-command-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  store.addProject('fixture',dir,'codex');const scheduler={tickNow(){}} as Scheduler;
  const run=await applyTaskAction(store,scheduler,parseCommand('开始【fixture】 --timeout-min 120 原文\n  第二行'),'dingtalk');assert.equal(run.ok,true);
  const task=store.listTasks()[0]!;assert.equal(task.timeout_min,120);assert.equal(task.prompt,'原文\n  第二行');
  await applyTaskAction(store,scheduler,parseCommand('开始【fixture】 请解释 --timeout-min 120'),'dingtalk');assert.equal(store.listTasks()[0]!.timeout_min,null);
  const count=store.listTasks().length;assert.equal((await applyTaskAction(store,scheduler,parseCommand('开始【fixture】 --timeout-min abc 描述'),'dingtalk')).ok,false);assert.equal(store.listTasks().length,count);
  const draft=store.addTask(task.project_id,'original draft',{draft:true,timeoutMin:120});
  const started=await applyTaskAction(store,scheduler,parseCommand(`开始 ${draft.id} --timeout-min 0`),'dingtalk');
  assert.equal(started.ok,true);assert.equal(store.getTask(draft.id)?.prompt,'original draft');assert.equal(store.getTask(draft.id)?.timeout_min,null);
});

test('private progress does not hide a visible-activity gap; warnings do not stop execution and recover once per episode', ()=>{
  let now=0,state:RunConnection|undefined;const alerts:Array<{kind:string,state:RunConnection}>=[];
  const watch=new ConnectionWatch({now:()=>now,inactivityAfterMs:1000,warningAfterMs:200,changed:s=>{state=s},notify:(kind,state)=>alerts.push({kind,state})});
  now=900;watch.progress(false);watch.tick();assert.equal(alerts.length,0);
  now=1000;watch.tick();watch.tick();assert.equal(state?.state,'inactive');assert.equal(alerts.length,1);
  watch.progress(false);assert.equal(state?.state,'inactive');
  const task={id:1,project_id:1,prompt:'original',status:'running' as const,created_at:''};
  const run={id:1,task_id:1,kind:'normal' as const,status:'running' as const,limits:{timeoutMin:null},connection:state};
  assert.match(taskStateLabel(taskView(task,run)),/运行中.*长时间无活动/);
  const event={kind:'run.connection_warning' as const,runId:1,task,project:{id:1,name:'fixture',agent_id:'codex',workspace_path:'',created_at:''},connection:state!,details:runDetails(run)};
  const en=buildEventMarkdown(event,'',undefined,'en');assert.match(en.title,/Running.*No visible activity/);assert.doesNotMatch(en.text,/connection errors|Connection timed out/);assert.match(en.text,/Unlimited/);
  now=1100;watch.progress();watch.progress();assert.equal(alerts.length,2);assert.equal(state?.state,'recovered');
  now=1200;watch.error('stream disconnected');now=1400;watch.tick();assert.equal(alerts.length,3);assert.equal(state?.state,'retrying');
  const restored=new ConnectionWatch({now:()=>now,previous:state,changed:s=>{state=s},notify:(kind,state)=>alerts.push({kind,state})});restored.tick();assert.equal(alerts.length,3);restored.progress();assert.equal(alerts.length,4);
});

test('managed execution with no deadline can finish and still cancel; an explicit deadline still stops it', {timeout:30000}, async t=>{
  const dir=mkdtempSync(resolve('data','test-native-limits-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const run=async(name:string,code:string,timeoutMs:number,cancel=false)=>{
    const control=join(dir,name),result=await runManagedNative({cmd:[process.execPath,'-e',code],cwd:dir,timeoutMs,
      onStdoutLine:line=>{if(cancel&&line==='ready')writeFileSync(control+'.cancel','requested')}},control,()=>{});
    return{result,receipt:nativeExecution(control)};
  };
  const normal=await run('unlimited',"setTimeout(()=>console.log('done'),250)",0);assert.equal(normal.result.exitCode,0);assert.ok(!normal.receipt?.timedOut);
  const stopped=await run('limited',"setTimeout(()=>{},2000)",150);assert.equal(stopped.receipt?.timedOut,true);
  const cancelled=await run('cancel',"console.log('ready');setTimeout(()=>{},2000)",0,true);assert.equal(cancelled.receipt?.cancelled,true);assert.ok(!cancelled.receipt?.timedOut);
});

test('recovered live workers still get an inactivity notification without a new Run or termination', async t=>{
  const dir=mkdtempSync(resolve('data','test-recovered-inactivity-')),cfg=loadConfig({configPath:join(dir,'absent.json'),dataDir:dir,logDir:dir});let store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  const p=store.addProject('fixture',dir,'codex'),task=store.addTask(p.id,'original'),run=store.beginRun(task.id)!;
  store.updateRun(run.id,{status:'running',worker:{kind:'native',pid:process.pid}});
  store.recordRunActivity(run.id,{key:'work',kind:'tool',phase:'started',at:new Date(Date.now()-660000).toISOString()});
  const events:any[]=[];const bus=new EventBus([{name:'fixture',notify:async e=>{events.push(e)}}]);
  let runner=new Runner({cfg,store,docker:new Docker(),events:bus});
  assert.equal(await runner.recoverRun(store.getRun(run.id)!),false);assert.equal(await runner.recoverRun(store.getRun(run.id)!),false);
  assert.equal(events.length,1);assert.equal(events[0].connection.state,'inactive');assert.equal(events[0].details.stopped,false);
  assert.equal(events[0].activities.length,1);assert.equal(store.getTask(task.id)?.status,'running');
  store.close();store=new Store(dir);runner=new Runner({cfg,store,docker:new Docker(),events:bus});
  await runner.recoverRun(store.getRun(run.id)!);assert.equal(events.length,1);
  store.recordRunActivity(run.id,{key:'work',kind:'tool',phase:'completed',at:new Date().toISOString()});
  await runner.recoverRun(store.getRun(run.id)!);assert.equal(events.length,2);assert.equal(events[1].kind,'run.connection_recovered');
  assert.equal(store.runsOfTask(task.id).length,1);assert.equal(store.getRun(run.id)?.execution,undefined);
});

test('a slow activity notification cannot arrive after the same Run ending notification', async t=>{
  let release!:()=>void;const blocked=new Promise<void>(r=>{release=r}),titles:string[]=[];
  t.mock.method(globalThis,'fetch',async(input:any,options:any)=>{
    if(String(input).includes('accessToken'))return Response.json({accessToken:'fixture',expireIn:7200});
    titles.push(JSON.parse(JSON.parse(options.body).msgParam).title);if(titles.length===1)await blocked;
    return Response.json({processQueryKey:'fixture'});
  });
  const task={id:1,project_id:1,prompt:'original',status:'running' as const,created_at:''},project={id:1,name:'fixture',agent_id:'codex',workspace_path:'',created_at:''};
  const notifier=new DingTalkAppNotifier('fixture','fixture','',['failed','succeeded'],{conversationId:'fixture'},async()=> 'https://alidocs.dingtalk.com/i/nodes/fixture');
  const warning=notifier.notify({kind:'run.connection_warning',task,project,runId:1,connection:{state:'inactive',since:'',lastProgressAt:'',reason:'quiet'}});
  await setImmediate();const ended=notifier.notify({kind:'run.succeeded',task,project,runId:1,summary:{agentMessage:'done',finalReply:true,filesChanged:[],diffStat:''}});
  await setImmediate();assert.equal(titles.length,1);release();await Promise.all([warning,ended]);
  assert.match(titles[0]!,/运行中.*长时间无活动/);assert.match(titles[1]!,/已结束/);
});

test('long-running execution keeps its output cache bounded while streaming the entire content unchanged', async()=>{
  const text='中文🙂'.repeat(6000),lines:string[]=[];
  const result=await runNative({cmd:[process.execPath,'-e',`for(let i=0;i<100;i++)console.log(i+':'+${JSON.stringify(text)})`],cwd:process.cwd(),timeoutMs:10000,captureTail:3,onStdoutLine:line=>lines.push(line)});
  assert.equal(result.exitCode,0);assert.equal(lines.length,100);assert.equal(lines[0],'0:'+text);assert.equal(lines[99],'99:'+text);
  assert.equal(result.out.length,3);assert.ok(result.out.every(line=>line.length<16400));assert.ok(result.out.at(-1)!.startsWith('99:'));
});
