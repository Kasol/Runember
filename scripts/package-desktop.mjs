import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
if (!['win32', 'darwin'].includes(process.platform)) throw new Error('请在 Windows 或 macOS 上打包对应平台的客户端。');
if (!process.argv[2]) throw new Error('用法：npm run package:desktop -- <运行时目录> [输出目录]');
const runtime = resolve(root, process.argv[2]);
const windows = process.platform === 'win32';
const manifest = JSON.parse(readFileSync(join(runtime, 'runtime.json'), 'utf8'));
if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error('运行时的系统或架构与打包主机不一致。');
const output = resolve(root, process.argv[3] ?? 'dist/installers');
if (existsSync(output)) throw new Error('输出目录已存在，请使用新的目录。');
mkdirSync(output, { recursive: true });
const desktop = join(root, 'apps/desktop');
execFileSync(process.execPath, [process.env.npm_execpath, 'run', 'build', '-w', '@agentdesk/desktop'], { cwd: root, stdio: 'inherit' });
const require = createRequire(join(desktop, 'package.json'));
const { build, Platform, Arch } = require('electron-builder');
const electronBinary = require('electron');
execFileSync(process.execPath, [join(root, 'scripts/smoke-desktop.mjs'), runtime], { cwd:root, stdio:'inherit' });
const electronDist = process.platform === 'darwin' ? resolve(electronBinary, '../../../..') : resolve(electronBinary, '..');
const arch = process.arch === 'arm64' ? Arch.arm64 : Arch.x64;
const target = process.argv.includes('--dir') ? ['dir'] : windows ? ['nsis', 'zip'] : ['dmg', 'zip'];
const signedMac = process.platform === 'darwin' && !!process.env.CSC_LINK;
await build({ targets: (windows ? Platform.WINDOWS : Platform.MAC).createTarget(target, arch),
  publish: 'never', config: {
    appId: 'io.runember.desktop', productName: 'Runember',
    directories: { app: desktop, output },
    files: ['dist/main.mjs', 'dist/preload.cjs', 'assets/**/*', 'package.json'],
    extraResources: [{ from: runtime, to: 'agentdesk', filter: ['**/*', '!**/.env', '!**/*.log', '!**/agentdesk.db*', '!**/daemon.lock'] }],
    extraMetadata: { name: 'agentdesk', version: manifest.version },
    npmRebuild: false, asar: true, electronDist,
    artifactName: 'Runember-${version}-${os}-${arch}.${ext}',
    win: { target: ['nsis', 'zip'], signExecutable: false },
    nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, createDesktopShortcut: true },
    mac: { target: ['dmg', 'zip'], category: 'public.app-category.developer-tools', hardenedRuntime: signedMac,
      identity: signedMac ? undefined : null,
      notarize: signedMac && !!process.env.APPLE_API_KEY,
      extendInfo: { NSHumanReadableCopyright: 'Runember contributors' } },
  } });
for (const name of readdirSync(output)) if (/\.(exe|zip|dmg)$/.test(name)) {
  const sha = createHash('sha256').update(readFileSync(join(output, name))).digest('hex');
  writeFileSync(join(output, name + '.sha256'), `${sha}  ${name}\n`);
}
console.log(`Runember 客户端：${output}`);
