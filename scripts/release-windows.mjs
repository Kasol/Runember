import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'win32') throw new Error('Windows 发布包应在目标架构的 Windows 上构建。');
const npm = process.env.npm_execpath;
if (!npm) throw new Error('请用 npm run release:windows 构建。');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const name = `agentdesk-${version}-windows-${process.arch}`;
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
  target: 'node22',
  external: Object.keys(dependencies),
  logLevel: 'warning',
});
writeFileSync(join(output, 'package.json'), JSON.stringify({ name, version, private: true, type: 'module', dependencies }, null, 2) + '\n');
invokeNpm(output, 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund');
cpSync(join(root, 'apps/web/dist'), join(output, 'web'), { recursive: true });
cpSync(process.execPath, join(output, 'node.exe'));
cpSync(join(dirname(process.execPath), 'LICENSE'), join(output, 'NODE-LICENSE.txt'));
cpSync(join(root, 'docs/windows-quickstart.md'), join(output, 'README.md'));
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

const zip = output + '.zip';
execFileSync('tar.exe', ['-a', '-cf', zip, '-C', dirname(output), basename(output)], { stdio: 'inherit' });
console.log(`发布候选包 ${zip}`);
