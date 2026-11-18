import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { runtimeNode, hasRuntime, runtimePath } from '../../cli/src/runtime-files.js';
import { runManagedNative, nativeExecution, stoppedNativeGroup } from '../src/managed-native.js';

test('runtime layouts distinguish Windows and macOS and provide a GUI-safe PATH', t => {
  const dir = mkdtempSync(resolve('data', 'test-platform-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'web'));
  for (const f of ['node', 'desk.mjs', 'daemon.mjs', 'web/index.html']) writeFileSync(join(dir, f), '');
  assert.equal(runtimeNode('darwin'), 'node'); assert.equal(runtimeNode('win32'), 'node.exe');
  assert.equal(hasRuntime(dir, 'darwin'), true); assert.equal(hasRuntime(dir, 'win32'), false);
  writeFileSync(join(dir, 'node.exe'), ''); assert.equal(hasRuntime(dir, 'win32'), true);
  const macPath = runtimePath('/runtime', '/usr/bin:/bin', 'darwin', '/Users/fixture').split(':');
  assert.equal(macPath[0], '/runtime'); assert.ok(macPath.includes('/opt/homebrew/bin')); assert.ok(macPath.includes('/usr/local/bin'));
  assert.equal(new Set(macPath).size, macPath.length);
});

test('POSIX cancellation confirms the managed process group has stopped', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(resolve('data', 'test-posix-stop-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const control = join(dir, 'run.control');
  const job = runManagedNative({ cmd: [process.execPath, '-e', "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)"], cwd: dir, timeoutMs: 12000 }, control, () => {});
  for (let i = 0; i < 100; i++) {
    try { if (JSON.parse(readFileSync(control + '.active', 'utf8')).pgid) break; } catch {}
    await new Promise(r => setTimeout(r, 30));
  }
  writeFileSync(control + '.cancel', '');
  await job;
  assert.equal(nativeExecution(control)?.cancelled, true);
  assert.equal(await stoppedNativeGroup(control, dir), true);
});
