import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';

test('Windows installer verifies downloads, preserves existing directories and reports setup needs', { skip: process.platform !== 'win32' }, t => {
  const dir = mkdtempSync(resolve('data', 'test-installer-'));
  t.after(() => rmSync(dir, { recursive:true, force:true }));
  const folder = 'runember-2.2.0-beta.1-windows-x64';
  const source = join(dir, folder); mkdirSync(source);
  writeFileSync(join(source,'runtime.json'), JSON.stringify({product:'Runember',version:'2.2.0-beta.1',platform:'win32',arch:'x64'}));
  writeFileSync(join(source,'runember.cmd'), '@echo off\r\necho {"schemaVersion":1,"findings":[]}\r\nexit /b 0\r\n');
  const archive = join(dir,'runtime.zip');
  execFileSync('tar.exe',['-a','-cf',archive,'-C',dir,folder],{windowsHide:true});
  writeFileSync(archive+'.sha256',createHash('sha256').update(readFileSync(archive)).digest('hex')+'  runtime.zip\n');
  const harness = join(dir,'harness.ps1');
  writeFileSync(harness, `param($Installer,$FixtureArchive,$Destination,$Mode)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
function Invoke-WebRequest { param($Uri,$OutFile,[switch]$UseBasicParsing)
  if($Mode -eq 'no-download'){throw 'Unexpected download'}
  if($Uri.EndsWith('.sha256')) { if($Mode -eq 'bad-hash'){Set-Content -LiteralPath $OutFile -Value ('0'*64)}else{Copy-Item -LiteralPath ($FixtureArchive+'.sha256') -Destination $OutFile} }
  else {Copy-Item -LiteralPath $FixtureArchive -Destination $OutFile}
}
& $Installer -InstallDir $Destination -Json
exit $LASTEXITCODE
`);
  const installer=resolve('scripts/install.ps1');
  // Only this test subprocess permits executing the locally generated fixture scripts.
  const run=(destination:string,mode='good')=>spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',harness,installer,archive,destination,mode],{encoding:'utf8',windowsHide:true,timeout:30000});
  const destination=join(dir,'installed with spaces');
  const first=run(destination); assert.equal(first.status,0,first.stderr); assert.equal(JSON.parse(first.stdout).status,'installed');
  writeFileSync(join(destination,'keep.txt'),'original');
  const reuse=run(destination,'no-download'); assert.equal(reuse.status,0,reuse.stderr); assert.equal(readFileSync(join(destination,'keep.txt'),'utf8'),'original');
  const corrupt=join(dir,'bad-download'); const bad=run(corrupt,'bad-hash'); assert.notEqual(bad.status,0); assert.equal(existsSync(corrupt),false); assert.match(bad.stderr,/校验失败/);
  const unrelated=join(dir,'unrelated');mkdirSync(unrelated);writeFileSync(join(unrelated,'keep.txt'),'foreign');
  assert.notEqual(run(unrelated,'no-download').status,0);assert.equal(readFileSync(join(unrelated,'keep.txt'),'utf8'),'foreign');
  writeFileSync(join(destination,'runember.cmd'),'@echo off\r\necho {"findings":[{"level":"error"}]}\r\nexit /b 1\r\n');
  const setup=run(destination,'no-download');assert.equal(setup.status,2,setup.stderr);assert.equal(JSON.parse(setup.stdout).status,'needs_setup');
});

test('macOS installer shell syntax is valid', { skip:process.platform!=='darwin' },()=>{
  execFileSync('/bin/sh',['-n',resolve('scripts/install.sh')]);
});
