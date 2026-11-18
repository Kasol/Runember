import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = join(root, 'apps', 'desktop');
if (process.platform !== 'win32') throw new Error('请在 Windows 上构建桌面预览包。');
if (!process.argv[2]) throw new Error('用法: npm run release:desktop -- <Windows 发布包目录> [输出目录]');
const runtime = resolve(root, process.argv[2]);
const output = resolve(root, process.argv[3] ?? 'dist/agentdesk-desktop-windows');
const childFiles = ['node.exe', 'NODE-LICENSE.txt', 'desk.mjs', 'desk.cmd', 'daemon.mjs', 'package.json', 'node_modules', 'web'];
for (const name of childFiles) statSync(join(runtime, name));

const npm = process.env.npm_execpath;
if (!npm) throw new Error('请用 npm run release:desktop 构建。');
execFileSync(process.execPath, [npm, 'run', 'build', '-w', '@agentdesk/desktop'], { cwd: root, stdio: 'inherit' });

const electron = createRequire(join(desktop, 'package.json'))('electron');
mkdirSync(dirname(output), { recursive: true });
mkdirSync(output);
cpSync(dirname(electron), output, { recursive: true });
renameSync(join(output, 'electron.exe'), join(output, 'Agentdesk.exe'));

const app = join(output, 'resources', 'app');
mkdirSync(app);
cpSync(join(desktop, 'dist', 'main.mjs'), join(app, 'main.mjs'));
cpSync(join(desktop, 'dist', 'preload.cjs'), join(app, 'preload.cjs'));
cpSync(join(desktop, 'assets'), join(app, 'assets'), { recursive: true });
const version = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8')).version;
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'agentdesk', version, type: 'module', main: 'main.mjs' }) + '\n');

const bundledRuntime = join(output, 'resources', 'agentdesk');
mkdirSync(bundledRuntime);
for (const name of childFiles) cpSync(join(runtime, name), join(bundledRuntime, name), { recursive: true });
console.log(`桌面预览包 ${join(output, 'Agentdesk.exe')}`);
