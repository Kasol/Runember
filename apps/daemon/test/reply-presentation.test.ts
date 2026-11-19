import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import Docker from 'dockerode';
import { collectAgentReply, readRunSummary, runDetails, runReplyPresentation, taskView, type AgentReply, type Run, type Task } from '@agentdesk/core';
import { getAdapter } from '@agentdesk/adapters';
import { buildEventMarkdown, runDetailsMarkdown } from '../src/dingtalk-markdown.js';
import { Store } from '../src/store.js';
import { applyTaskAction } from '../src/actions.js';
import type { Scheduler } from '../src/scheduler.js';
import { Runner } from '../src/runner.js';
import { EventBus } from '../src/notify.js';
import { loadConfig } from '../src/config.js';

const task: Task = { id: 29, project_id: 1, prompt: 'generic task', status: 'blocked', created_at: '' };
const project = { id: 1, name: 'fixture', agent_id: 'codex', workspace_path: '', created_at: '' };
const progress = '验证代理正在切换到最终提交，补做直接编辑复验。';
const run = (patch: Partial<Run> = {}): Run => ({ id: 72, task_id: 29, kind: 'resume', status: 'blocked', blocked_kind: 'timeout',
  summary_json: JSON.stringify({agentMessage: progress}), ...patch });

test('legacy timeout output is a historical message; final evidence and execution state remain independent', () => {
  const timedOut=runDetails(run());assert.equal(timedOut.responseKind,'last_message');assert.equal(timedOut.summary,progress);
  assert.equal(taskView(task,run()).state,'ended');assert.match(runReplyPresentation(timedOut).notice!,/本轮已停止，以下是停止前记录的消息/);
  const final=runDetails(run({summary_json:JSON.stringify({agentMessage:progress,finalReply:true})}));
  assert.equal(final.responseKind,'final');assert.equal(final.stage,'运行超时');assert.equal(runReplyPresentation(final).notice,undefined);
  const oldNormal=runDetails(run({status:'succeeded',blocked_kind:undefined,exit_code:0}));
  assert.equal(oldNormal.responseKind,'message');assert.equal(runReplyPresentation(oldNormal).title,'Agent 答复');
  const unconfirmed=runDetails(run({status:'succeeded',blocked_kind:undefined,exit_code:0,summary_json:JSON.stringify({agentMessage:'全部完成',finalReply:false})}));
  assert.equal(unconfirmed.responseKind,'last_message');
  for(const patch of [{status:'cancelled' as const},{blocked_kind:'interrupted' as const},{status:'failed' as const,exit_code:1}]) {
    assert.equal(runDetails(run(patch)).responseKind,'last_message');
  }
  const empty=runDetails(run({status:'failed',summary_json:JSON.stringify({diagnostic:'could not launch'})}));
  assert.equal(empty.responseKind,'none');assert.equal(runReplyPresentation(empty).title,'本轮没有收到 Agent 答复');
  const emptyFinal=runDetails(run({summary_json:JSON.stringify({agentMessage:'',finalReply:true})}));
  assert.match(runReplyPresentation(emptyFinal).title,/未提供正文答复/);assert.doesNotMatch(runReplyPresentation(emptyFinal).notice!,/未收到最终答复/);
  const active=runDetails(run({status:'running',blocked_kind:undefined}));
  assert.equal(runReplyPresentation(active).title,'Agent 最近消息');assert.equal(runReplyPresentation(active).notice,undefined);
});

test('adapter evidence identifies final responses without inferring from message wording or process exit', () => {
  const codex=getAdapter('codex','','');const message=(text:string)=>JSON.stringify({type:'item.completed',item:{type:'agent_message',text}});
  let reply:AgentReply={text:'',final:false};
  reply=collectAgentReply(reply,codex.parseLine(message('最终答复：全部完成；正在执行'))!,'2026-01-01T00:00:00Z');
  assert.equal(reply.final,false);
  reply=collectAgentReply(reply,codex.parseLine(JSON.stringify({type:'turn.completed'}))!);
  assert.equal(reply.final,true);assert.equal(reply.receivedAt,'2026-01-01T00:00:00Z');
  reply=collectAgentReply(reply,codex.parseLine(JSON.stringify({type:'turn.started'}))!);assert.equal(reply.final,false);
  const structured=codex.parseLine(message(JSON.stringify({answer:'Tests failed. More work is needed.',input_request:null})),true)!;
  assert.equal(collectAgentReply(reply,structured).final,true);
  for(const [agent,line] of [['deepseek',{type:'final',text:'still more work'}],['zcode',{type:'turn.completed',payload:{response:'still more work'}}]] as const) {
    assert.equal(collectAgentReply(reply,getAdapter(agent,'','').parseLine(JSON.stringify(line))!).final,true);
  }
  reply=collectAgentReply(reply,{type:'agent_message',text:progress});assert.equal(reply.final,false);
});

test('Chinese and English notices preserve the quoted progress and keep questions first', () => {
  const details=runDetails(run({summary_json:JSON.stringify({agentMessage:progress,finalReply:false})}));
  for(const language of ['zh-CN','en'] as const) {
    const event={kind:'run.blocked' as const,runId:72,task,project,blockedKind:'timeout' as const,details};
    const preview=buildEventMarkdown(event,'','https://alidocs.dingtalk.com/i/nodes/fixture',language);
    assert.equal(preview.title,language==='en'?'⏹ Ended · Timed out':'⏹ 已结束 · 运行超时');
    assert.match(preview.text,language==='en'?/This run has stopped\. No final response was received/:/本轮已停止，未收到最终答复/);
    assert.ok(preview.text.includes('> '+progress));assert.ok(!preview.text.includes(language==='en'?'Agent final response':'Agent 最终答复'));
    const full=runDetailsMarkdown(details,false,language);assert.ok(full.includes('> '+progress));
    const labels=runReplyPresentation(details,language);if(language==='en')assert.doesNotMatch(JSON.stringify(labels),/[\u4e00-\u9fff]/);
  }
  const waiting=runDetails(run({blocked_kind:'approval_needed',exit_code:0,summary_json:JSON.stringify({agentMessage:progress,finalReply:false,inputRequest:'Which account?'})}));
  const text=runDetailsMarkdown(waiting,true,'en');assert.ok(text.indexOf('Which account?')<text.indexOf('Run #72'));
  assert.match(text,/awaiting your input/);assert.doesNotMatch(text,/No final response/);
});

test('task status shows the current Run while an older Run retains its own stopped presentation', async t => {
  const dir=mkdtempSync(resolve('data','test-reply-history-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  const p=store.addProject('fixture',dir,'codex'),task=store.addTask(p.id,'original'),old=store.beginRun(task.id)!;
  store.finishRun(old.id,{status:'blocked',blocked_kind:'timeout',session_id:'original-session',summary_json:JSON.stringify({agentMessage:progress})},'blocked');
  const snapshot=store.getRun(old.id);const oldDetails=runDetails(snapshot!);
  store.setTaskStatus(task.id,'queued');const next=store.beginRun(task.id)!;store.updateRun(next.id,{status:'running'});
  const status=await applyTaskAction(store,{tickNow(){}} as Scheduler,{type:'status',taskId:task.id},'dingtalk');
  assert.match(status.message,new RegExp(`Run #${next.id}`));assert.match(status.message,/运行中/);
  assert.doesNotMatch(status.message,/本轮已停止/);assert.equal(runReplyPresentation(oldDetails).title,'停止前最后一条消息');
  assert.deepEqual(store.getRun(old.id),snapshot);
});

test('Runner persists reply evidence while streaming and retains it when a run times out or is recovered', async t => {
  const dir=mkdtempSync(resolve('data','test-runner-reply-')),store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  const git=(...args:string[])=>execFileSync('git',args,{cwd:dir,windowsHide:true,stdio:'pipe'});
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
  writeFileSync(resolve(dir,'README.md'),'fixture');git('add','README.md');git('-c','commit.gpgsign=false','commit','-qm','fixture');
  const cfg=loadConfig({configPath:resolve(dir,'absent.json'),dataDir:resolve(dir,'state'),logDir:resolve(dir,'logs')});
  cfg.scheduler.taskTimeoutMin=30;
  const p=store.addProject('fixture',dir,'codex','isolation');
  const runner=new Runner({cfg,store,docker:new Docker(),events:new EventBus([])});
  t.mock.method(runner as any,'seedSkills',async()=>{});t.mock.method(runner as any,'ensureVolume',async()=>{});
  let mode:'final'|'timeout'|'empty'='final';let streamingChecks=0;
  t.mock.method(runner as any,'spawn',async(opts:any)=>{
    if(opts.cmd[0]==='/bin/sh')return{exitCode:0,killed:false,out:[],err:[]};
    assert.equal(opts.timeoutMs,mode==='timeout'?60000:0);
    if(mode!=='empty'){
      const value=mode==='final'?JSON.stringify({answer:'A final answer with remaining work.',input_request:null}):progress;
      opts.onStdoutLine(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:value}}));
      const saved=store.activeRuns()[0]!;assert.equal(readRunSummary(saved)?.finalReply,mode==='final');
      assert.ok(readRunSummary(saved)?.agentMessageAt);streamingChecks++;
    }
    return{exitCode:mode==='timeout'?null:0,killed:mode==='timeout',out:[],err:[],execution:{exitCode:mode==='timeout'?null:0,timedOut:mode==='timeout',stoppedAt:new Date().toISOString()}};
  });
  for(const scenario of ['final','timeout','empty'] as const){
    mode=scenario;const task=store.addTask(p.id,'original text',{timeoutMin:scenario==='timeout'?1:null});await runner.execute(task.id);
    const saved=store.latestRun(task.id)!,details=runDetails(saved);
    assert.equal(details.responseKind,scenario==='final'?'final':scenario==='empty'?'none':'last_message');
    assert.equal(taskView(store.getTask(task.id)!,saved).state,'ended');
    if(scenario==='final'){
      store.updateRun(saved.id,{status:'running'});store.setTaskStatus(task.id,'running');
      assert.equal(await runner.recoverRun(store.getRun(saved.id)!),true);
      assert.equal(runDetails(store.getRun(saved.id)!).responseKind,'final');
    }
  }
  assert.equal(streamingChecks,2);
});
