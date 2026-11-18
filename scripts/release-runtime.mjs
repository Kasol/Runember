import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
if (!['win32', 'darwin'].includes(process.platform)) throw new Error('请在 Windows 或 macOS 上构建。');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('发布构建需要 Node.js 24 或更新版本。');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('请用 npm run release:runtime 构建。');
const rootPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = rootPackage.version;
const name = `runember-${version}-${windows ? 'windows' : 'macos'}-${process.arch}`;
const output = resolve(root, process.argv[2] ?? join('dist', name));
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output); // 避免覆盖现有发布包

const invokeNpm = (cwd, ...args) => execFileSync(process.execPath, [npm, ...args], { cwd, stdio: 'inherit' });
invokeNpm(root, 'run', 'typecheck');
invokeNpm(root, 'run', 'build', '-w', 'apps/web');

const dependencies = {};
const declared = JSON.parse(readFileSync(join(root, 'apps/daemon/package.json'), 'utf8')).dependencies;
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
for (const key of Object.keys(declared).filter(key => !key.startsWith('@agentdesk/'))) {
  const entry = lock.packages[`node_modules/${key}`] ?? lock.packages[`apps/daemon/node_modules/${key}`];
  if (!entry?.version) throw new Error(`缺少 ${key} 对应的锁定版本`);
  dependencies[key] = entry.version;
}
await build({
  absWorkingDir: root,
  entryPoints: { daemon: 'apps/daemon/src/index.ts', desk: 'apps/cli/src/index.ts' },
  outdir: output,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: Object.keys(dependencies),
  logLevel: 'warning',
});
writeFileSync(join(output, 'package.json'), JSON.stringify({ name, version, private: true, type: 'module', dependencies, overrides: rootPackage.overrides }, null, 2) + '\n');
invokeNpm(output, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund');
cpSync(join(root, 'apps/web/dist'), join(output, 'web'), { recursive: true });
cpSync(join(root, 'LICENSE'), join(output, 'LICENSE'));
cpSync(process.execPath, join(output, windows ? 'node.exe' : 'node'));
if (!windows) chmodSync(join(output, 'node'), 0o755);
const license = [join(dirname(process.execPath), 'LICENSE'), join(dirname(process.execPath), '..', 'LICENSE')].find(existsSync);
if (license) cpSync(license, join(output, 'NODE-LICENSE.txt'));
else {
  const response = await fetch('https://raw.githubusercontent.com/nodejs/node/v' + process.versions.node + '/LICENSE');
  if (!response.ok) throw new Error('无法取得所捆绑 Node.js 版本的许可证。');
  const text = await response.text();
  if (!text.includes('Node.js is licensed')) throw new Error('Node.js 许可证无效。');
  writeFileSync(join(output, 'NODE-LICENSE.txt'), text);
}
cpSync(join(root, existsSync(join(root, 'docs/install.md')) ? 'docs/install.md' : 'docs/windows-quickstart.md'), join(output, 'README.md'));
writeFileSync(join(output, 'runtime.json'), JSON.stringify({ product: 'Runember', version, platform: process.platform, arch: process.arch, node: process.versions.node }, null, 2));
if (windows) {
writeFileSync(join(output, 'desk.cmd'), [
  '@echo off', 'setlocal', 'set "AGENTDESK_APP_DIR=%~dp0"',
  '"%~dp0node.exe" "%~dp0desk.mjs" %*', 'exit /b %ERRORLEVEL%', '',
].join('\r\n'));
writeFileSync(join(output, 'Start Agentdesk.cmd'), [
  '@echo off', 'call "%~dp0desk.cmd" start', 'if errorlevel 1 pause', '',
].join('\r\n'));
writeFileSync(join(output, 'Stop Agentdesk.cmd'), [
  '@echo off', 'call "%~dp0desk.cmd" stop', 'if errorlevel 1 pause', '',
].join('\r\n'));

cpSync(join(output, 'desk.cmd'), join(output, 'runember.cmd'));
cpSync(join(output, 'Start Agentdesk.cmd'), join(output, 'Start Runember.cmd'));
cpSync(join(output, 'Stop Agentdesk.cmd'), join(output, 'Stop Runember.cmd'));
} else {
 const cli = ['#!/bin/sh', 'APP_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)', 'export AGENTDESK_APP_DIR="$APP_DIR"', 'export PATH="$APP_DIR:$PATH"', 'exec "$APP_DIR/node" "$APP_DIR/desk.mjs" "$@"', ''].join('\n');
 for (const name of ['desk', 'runember']) { writeFileSync(join(output, name), cli); chmodSync(join(output, name), 0o755); }
 for (const [label, action] of [['Start','start'],['Stop','stop']]) {
 const file = join(output, label + ' Runember.command');
 writeFileSync(file, ['#!/bin/sh', 'APP_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd)', 'exec "$APP_DIR/desk" ' + action, ''].join('\n')); chmodSync(file, 0o755);
 }
}
const zip = output + (windows ? '.zip' : '.tar.gz');
execFileSync(windows ? 'tar.exe' : 'tar', windows ? ['-a', '-cf', zip, '-C', dirname(output), basename(output)] : ['-czf', zip, '-C', dirname(output), basename(output)], { stdio: 'inherit' });
writeFileSync(zip + '.sha256', createHash('sha256').update(readFileSync(zip)).digest('hex') + '  ' + basename(zip) + '\n');
console.log(`发布候选包 ${zip}`);
