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
const electronDist = process.platform === 'darwin' ? resolve(electronBinary, '../../../..') : resolve(electronBinary, '..');
const arch = process.arch === 'arm64' ? Arch.arm64 : Arch.x64;
const target = process.argv.includes('--dir') ? ['dir'] : windows ? ['nsis', 'zip'] : ['dmg', 'zip'];
const signedMac = process.platform === 'darwin' && !!process.env.CSC_LINK;
const signedWindows = windows && !!(process.env.WIN_CSC_LINK || process.env.CSC_LINK);
const requireWindowsSigning = windows && process.env.RUNEMBER_REQUIRE_WINDOWS_SIGNING === '1';
if (requireWindowsSigning && !signedWindows) throw new Error('Windows 发布要求代码签名，请配置 WIN_CSC_LINK 或 CSC_LINK。');
if (windows && !signedWindows) console.warn('正在构建未签名的 Windows 内测包；智能应用控制可能阻止安装。对外分发前需配置可信代码签名。');
await build({ targets: (windows ? Platform.WINDOWS : Platform.MAC).createTarget(target, arch),
  publish: 'never', config: {
    appId: 'io.runember.desktop', productName: 'Runember',
    directories: { app: desktop, output },
    files: ['dist/main.mjs', 'dist/preload.cjs', 'assets/**/*', 'package.json'],
    // electron-builder always skips a FileSet's root node_modules directory.
    // Map it separately so the daemon's external packages reach the installed app.
    extraResources: [
      { from: runtime, to: 'agentdesk', filter: ['**/*', '!node_modules{,/**/*}', '!**/.env', '!**/*.log', '!**/agentdesk.db*', '!**/daemon.lock'] },
      { from: join(runtime, 'node_modules'), to: 'agentdesk/node_modules', filter: ['**/*'] },
    ],
    afterPack: async context => {
      const resources = windows ? join(context.appOutDir, 'resources') : join(context.appOutDir, 'Runember.app/Contents/Resources');
      const installedRuntime = join(resources, 'agentdesk');
      for (const args of [
        ['scripts/smoke-runtime.mjs', installedRuntime],
        ['scripts/smoke-desktop.mjs', installedRuntime, join(resources, 'app.asar')],
        ['scripts/smoke-desktop.mjs', installedRuntime, join(resources, 'app.asar'), '--startup-failure'],
      ]) execFileSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
    },
    extraMetadata: { name: 'agentdesk', version: manifest.version },
    npmRebuild: false, asar: true, electronDist,
    artifactName: 'Runember-${version}-${os}-${arch}.${ext}',
    forceCodeSigning: requireWindowsSigning || signedWindows || signedMac,
    win: { target: ['nsis', 'zip'], signExecutable: signedWindows },
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
