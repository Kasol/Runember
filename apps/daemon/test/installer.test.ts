import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';

test('Windows installer verifies downloads, preserves existing directories and reports setup needs', { skip: process.platform !== 'win32' }, t => {
  const dir = mkdtempSync(resolve('data', 'test-installer-'));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  const version = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;
  const folder = `runember-${version}-windows-x64`;
  const source = join(dir, folder); mkdirSync(source);
  writeFileSync(join(source,'runtime.json'), JSON.stringify({product:'Runember',version,platform:'win32',arch:'x64'}));
  writeFileSync(join(source,'runember.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0desk.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n');
  // Exercise the real UTF-8 Node boundary, including a GBK PowerShell parent.
  copyFileSync(process.execPath,join(source,'node.exe'));
  writeFileSync(join(source,'desk.mjs'), "import fs from 'node:fs';import {fileURLToPath}from'node:url';if(process.argv.includes('start'))fs.writeFileSync(new URL('started',import.meta.url),'yes');else{const failed=fs.existsSync(fileURLToPath(new URL('needs-setup',import.meta.url)));console.log(JSON.stringify({schemaVersion:1,findings:[{level:failed?'error':'info',detail:'中文诊断正常'}]}));process.exitCode=failed?1:0}");
  const archive = join(dir,'runtime.zip');
  execFileSync('tar.exe',['-a','-cf',archive,'-C',dir,folder],{windowsHide:true});
  writeFileSync(archive+'.sha256',createHash('sha256').update(readFileSync(archive)).digest('hex')+'  runtime.zip\n');
  const harness = join(dir,'harness.ps1');
  writeFileSync(harness, `param($Installer,$FixtureArchive,$Destination,$Mode)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.Encoding]::GetEncoding(936)
function Invoke-WebRequest { param($Uri,$OutFile,[switch]$UseBasicParsing)
  if($Mode -eq 'no-download'){throw 'Unexpected download'}
  if($Uri.EndsWith('.sha256')) { if($Mode -eq 'bad-hash'){Set-Content -LiteralPath $OutFile -Value ('0'*64)}else{Copy-Item -LiteralPath ($FixtureArchive+'.sha256') -Destination $OutFile} }
  else {Copy-Item -LiteralPath $FixtureArchive -Destination $OutFile}
}
& $Installer -InstallDir $Destination -Json -Start:($Mode -eq 'start')
exit $LASTEXITCODE
`);
  const installer=resolve('scripts/install.ps1');
  // Only this test subprocess permits executing the locally generated fixture scripts.
  const run=(destination:string,mode='good')=>spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',harness,installer,archive,destination,mode],{encoding:'utf8',windowsHide:true,timeout:30000});
  const destination=join(dir,'installed with spaces');
  const first=run(destination); assert.equal(first.status,0,first.stderr); assert.equal(JSON.parse(first.stdout).status,'installed');
  assert.equal(JSON.parse(first.stdout).diagnostics.findings[0].detail,'中文诊断正常');
  const started=run(destination,'start');assert.equal(started.status,0,started.stderr);assert.equal(JSON.parse(started.stdout).status,'installed');assert.equal(JSON.parse(started.stdout).started,true);assert.equal(existsSync(join(destination,'started')),true);
  writeFileSync(join(destination,'keep.txt'),'original');
  const reuse=run(destination,'no-download'); assert.equal(reuse.status,0,reuse.stderr); assert.equal(readFileSync(join(destination,'keep.txt'),'utf8'),'original');
  const corrupt=join(dir,'bad-download'); const bad=run(corrupt,'bad-hash'); assert.notEqual(bad.status,0); assert.equal(existsSync(corrupt),false); assert.match(bad.stderr,/SHA256_CHECK_FAILED/);
  const unrelated=join(dir,'unrelated');mkdirSync(unrelated);writeFileSync(join(unrelated,'keep.txt'),'foreign');
  assert.notEqual(run(unrelated,'no-download').status,0);assert.equal(readFileSync(join(unrelated,'keep.txt'),'utf8'),'foreign');
  writeFileSync(join(destination,'needs-setup'),'');
  const setup=run(destination,'no-download');assert.equal(setup.status,2,setup.stderr);assert.equal(JSON.parse(setup.stdout).status,'needs_setup');
});

test('macOS installer shell syntax is valid', { skip:process.platform!=='darwin' },()=>{
  execFileSync('/bin/sh',['-n',resolve('scripts/install.sh')]);
});
