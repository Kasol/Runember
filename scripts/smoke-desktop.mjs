import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, openSync, closeSync, existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync,spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

const root=fileURLToPath(new URL('../',import.meta.url));
const runtime=resolve(process.argv[2]);
mkdirSync(join(root,'data'),{recursive:true});
const fixture=mkdtempSync(join(root,'data','desktop-smoke-'));
const entry=join(fixture,'app');
mkdirSync(join(entry,'assets'),{recursive:true});mkdirSync(join(fixture,'profile'));
copyFileSync(join(root,'apps/desktop/assets/tray.png'),join(entry,'assets/tray.png'));
writeFileSync(join(entry,'package.json'),JSON.stringify({name:'runember-desktop-selftest',version:'2.2.0-beta.2',main:'main.cjs'}));
const reserve=net.createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const config=join(fixture,'config.json');
writeFileSync(config,JSON.stringify({dataDir:join(fixture,'state'),logDir:join(fixture,'logs'),server:{host:'127.0.0.1',port},notify:{channels:[]},feedback:{}}));
const resultFile=join(fixture,'result.json');
writeFileSync(join(entry,'main.cjs'),`
const {app,Menu,dialog}=require('electron');const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(join(fixture,'profile'))});
const result=${JSON.stringify(resultFile)};
const fail=e=>{fs.writeFileSync(result,JSON.stringify({error:e.stack||String(e)}));app.exit(1)};
process.on('uncaughtException',fail);dialog.showErrorBox=(title,detail)=>fail(new Error(title+': '+detail));dialog.showMessageBox=async()=>({response:1});
setTimeout(()=>fail(new Error('Desktop startup timed out')),45000).unref();
app.on('browser-window-created',(_,win)=>{
 win.webContents.setBackgroundThrottling(false);
 if(process.platform==='win32')win.on('show',()=>win.hide());
 win.webContents.once('did-finish-load',async()=>{try{
  let before;for(let i=0;i<100;i++){before=await win.webContents.executeJavaScript('({title:document.title,guide:!!document.querySelector(".tour-overlay[open]"),body:document.body.innerText.slice(0,500)})');if(before.guide)break;await new Promise(r=>setTimeout(r,200));}
  await win.webContents.executeJavaScript('document.querySelector("[aria-label=关闭引导]")?.click();document.querySelector("[data-guide=environment]")?.click()');
  let diagnosis=false;for(let i=0;i<100;i++){diagnosis=await win.webContents.executeJavaScript('!!document.querySelector(".diagnostic-finding")');if(diagnosis)break;await new Promise(r=>setTimeout(r,200));}
  const help=Menu.getApplicationMenu().items.find(x=>x.label==='帮助')?.submenu.items.map(x=>x.label)||[];
  fs.writeFileSync(result,JSON.stringify({title:before.title,firstLaunchGuide:before.guide,diagnosis,offlineDiagnosisMenu:help.some(x=>x.includes('本机诊断')),node:process.versions.node,...(!before.guide?{body:before.body}:{})}));app.exit(0);
 }catch(e){fail(e)}});
});
import(require('node:url').pathToFileURL(${JSON.stringify(join(root,'apps/desktop/dist/main.mjs'))}).href).catch(fail);
`);
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('AGENTDESK_')&&k!=='ELECTRON_RUN_AS_NODE'));
Object.assign(env,{AGENTDESK_APP_DIR:runtime,AGENTDESK_CONFIG:config,HOME:fixture,USERPROFILE:fixture,CODEX_HOME:join(fixture,'.codex'),DSH_HOME:join(fixture,'.dsh')});
const electron=createRequire(join(root,'apps/desktop/package.json'))('electron');
const log=openSync(join(fixture,'electron.log'),'a');
let child;
const stopHost=()=>{if(child&&child.exitCode===null){try{if(process.platform==='win32')execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});else child.kill('SIGKILL');}catch{}}};
try{
 child=spawn(electron,[entry],{env,windowsHide:true,stdio:['ignore',log,log]});
 let launchError;child.once('error',error=>{launchError=error});
 const exit=new Promise(resolve=>child.once('exit',resolve));
 for(let i=0;i<250&&!existsSync(resultFile);i++){if(launchError)throw launchError;if(child.exitCode!==null)break;await delay(200);}
 const result=JSON.parse(readFileSync(resultFile,'utf8'));
 // Terminate only this disposable UI host; the detached daemon must survive it.
 stopHost();
 await Promise.race([exit,delay(5000).then(()=>{throw Error('Test UI host did not stop')})]);
 assert.ok(!result.error,JSON.stringify(result));assert.equal(result.title,'Runember');assert.ok(result.firstLaunchGuide,JSON.stringify(result));assert.ok(result.diagnosis);assert.ok(result.offlineDiagnosisMenu);
 const health=await fetch('http://127.0.0.1:'+port+'/healthz',{signal:AbortSignal.timeout(3000)});assert.equal(health.status,200);
 console.log(JSON.stringify({desktopStartup:true,firstLaunchGuide:true,diagnostics:true,daemonSurvivesClient:true,platform:process.platform,fixture}));
}finally{
 stopHost();
 closeSync(log);
 try{execFileSync(join(runtime,process.platform==='win32'?'node.exe':'node'),[join(runtime,'desk.mjs'),'stop'],{env,windowsHide:true,stdio:'ignore',timeout:15000});}catch{}
 await delay(500);
}
