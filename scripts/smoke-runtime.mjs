import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';

const runtime = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(join(runtime, 'runtime.json'), 'utf8'));
assert.equal(manifest.product, 'Runember'); assert.equal(manifest.platform, process.platform); assert.equal(manifest.arch, process.arch);
const fixture = mkdtempSync(resolve('data', 'runtime-smoke-'));
const workspace = join(fixture, 'workspace space'), oldLogs = join(fixture, 'old-logs'), nextLogs = join(fixture, 'new-logs'), state = join(fixture, 'state');
for (const directory of [workspace, oldLogs, nextLogs, state]) mkdirSync(directory, { recursive: true });
writeFileSync(join(workspace, 'package.json'), '{"name":"runember-selftest"}');
for (const args of [['init','-q'],['config','user.name','Runember Selftest'],['config','user.email','selftest@example.invalid'],['add','package.json'],['commit','-q','-m','fixture']]) execFileSync('git', args, { cwd: workspace, windowsHide: true });
const engine = join(fixture, 'fixture-agent.cjs');
writeFileSync(engine, `if(process.argv.join(' ').includes('simulate-start-failure')){console.error('无法定位 CLI ZCode Built-in Provider Config: fixture');process.exit(1)}console.log(JSON.stringify({type:'session',sessionId:'fixture-session'}));console.log(JSON.stringify({type:'final',text:'Runember runtime selftest passed'}));`);
const reserve = net.createServer(); await new Promise(r => reserve.listen(0, '127.0.0.1', r)); const port = reserve.address().port; await new Promise(r => reserve.close(r));
const config = join(fixture, 'config.json');
writeFileSync(config, JSON.stringify({ server: { host:'127.0.0.1', port }, dataDir: state, logDir: oldLogs, scheduler: { tickMs: 100 }, agents: { deepseek: { executable: engine } }, notify: { channels: [] }, feedback: {} }));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTDESK_')));
Object.assign(env, { AGENTDESK_APP_DIR: runtime, AGENTDESK_CONFIG: config, USERPROFILE: fixture, HOME: fixture, DSH_HOME: join(fixture,'.dsh'), CODEX_HOME: join(fixture,'.codex') });
const node = join(runtime, process.platform === 'win32' ? 'node.exe' : 'node');
const cli = (...args) => execFileSync(node, [join(runtime,'desk.mjs'), ...args], { env, encoding:'utf8', windowsHide:true, timeout:30000 });
const base = 'http://127.0.0.1:' + port;
const request = async (path, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(base + path, { method, headers: {'content-type':'application/json', connection:'close'}, body: body && JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value;
};
const stopped = async () => { for(let i=0;i<100;i++){if(!existsSync(join(state,'daemon.lock')))return;await delay(100);}throw Error('Daemon did not stop'); };
const ended = async id => { for(let i=0;i<200;i++){const d=await request('/api/tasks/'+id);if(d.task.state==='ended')return d;await delay(100);}throw Error('Task did not settle'); };
let failureTask;
try {
  cli('start','--no-browser');
  const { project } = await request('/api/projects', { name:'selftest', workspace_path:workspace, agent_id:'deepseek' });
  const { task } = await request('/api/tasks', { project:project.id, prompt:'read-only fixture' });
  const first = await ended(task.id); assert.equal(first.details.exitCode,0); assert.match(first.details.summary,/selftest passed/);
  const normal = await request('/api/tasks/'+task.id+'/diagnostics'); assert.ok(normal.findings.some(x=>x.code==='normal_exit'));
  const pending = await request('/api/settings/storage', { logDir:nextLogs }, 'PATCH'); assert.equal(pending.restartRequired,true); assert.equal(pending.currentDir,oldLogs);
  cli('stop'); await stopped(); cli('start','--no-browser');
  const storage = await request('/api/settings/storage'); assert.equal(storage.currentDir,nextLogs); assert.equal(storage.restartRequired,false);
  await request('/api/tasks/'+task.id+'/actions',{type:'resume',feedback:'continue fixture'});
  for(let i=0;i<100;i++){const d=await request('/api/tasks/'+task.id);if(d.runs.length===2&&d.task.state==='ended'){assert.equal(d.runs[1].session_id,'fixture-session');assert.ok(d.runs[1].log_path.startsWith(nextLogs));break;}if(i===99)throw Error('Resume failed');await delay(100);}
  const bad = await request('/api/tasks',{project:project.id,prompt:'simulate-start-failure PRIVATE-PROMPT'}); failureTask=bad.task.id;
  await ended(failureTask);
  const diagnosis = await request('/api/tasks/'+failureTask+'/diagnostics'); assert.equal(diagnosis.findings[0].code,'provider_config_missing'); assert.ok(!JSON.stringify(diagnosis).includes('PRIVATE-PROMPT'));
  assert.ok(existsSync(join(nextLogs,'daemon.log'))); assert.ok(existsSync(join(oldLogs,'daemon.log')));
} finally { try { cli('stop'); await stopped(); } catch {} }
let offline;
try { cli('doctor','--task',String(failureTask),'--json'); throw Error('Expected diagnosis error exit code'); }
catch(error) { assert.equal(error.status,1); offline=JSON.parse(String(error.stdout)); }
assert.equal(offline.findings[0].code,'provider_config_missing');
const result={platform:process.platform,arch:process.arch,version:manifest.version,normalRun:true,resume:true,logDirectoryRestart:true,offlineDiagnosis:true,fixture};
writeFileSync(join(fixture,'result.json'),JSON.stringify(result)); console.log(JSON.stringify(result));
