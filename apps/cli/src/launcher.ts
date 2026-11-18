import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppConfig } from '../../daemon/src/config.js';

interface DaemonLock {
  instanceId?: string;
  key?: string;
  port?: number;
}

export function localAddress(cfg: AppConfig): string {
  const host = cfg.server.host === '::1' ? '[::1]' : '127.0.0.1';
  return `http://${host}:${cfg.server.port}`;
}

function lock(dir: string): DaemonLock | undefined {
  try { return JSON.parse(readFileSync(join(dir, 'daemon.lock'), 'utf8')); }
  catch { return undefined; }
}

async function health(url: string): Promise<{ instanceId?: string } | undefined> {
  try {
    const res = await fetch(url + '/healthz', { signal: AbortSignal.timeout(800) });
    return res.ok ? await res.json() as { instanceId?: string } : {};
  } catch { return undefined; }
}

function openBrowser(url: string): void {
  const args = process.platform === 'win32' ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url]
    : process.platform === 'darwin' ? ['open', url] : ['xdg-open', url];
  const child = spawn(args[0]!, args.slice(1), { detached: true, stdio: 'ignore', windowsHide: true });
  child.once('error', () => console.log(`在浏览器打开 ${url}`));
  child.unref();
}

export async function startDaemon(cfg: AppConfig, browser: boolean): Promise<void> {
  const dir = resolve(cfg.dataDir);
  const url = localAddress(cfg);
  const existing = await health(url);
  if (existing && (!existing.instanceId || existing.instanceId !== lock(dir)?.instanceId)) {
    throw new Error(`端口 ${cfg.server.port} 已有其他实例在使用。请检查数据目录和端口配置。`);
  }
  if (!existing) {
    const installed = process.env.AGENTDESK_APP_DIR;
    const entry = installed ? join(installed, 'daemon.mjs')
      : fileURLToPath(new URL('../../daemon/src/index.ts', import.meta.url));
    const web = installed ? join(installed, 'web') : resolve('apps/web/dist');
    if (!existsSync(join(web, 'index.html'))) {
      throw new Error('找不到 Web 构建产物。使用发布包，或先从仓库执行 npm run build -w apps/web。');
    }
    mkdirSync(cfg.logDir, { recursive: true });
    const path = join(cfg.logDir, 'daemon.log');
    const log = openSync(path, 'a', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [
        ...(installed ? [] : ['--import', 'tsx']), entry,
        '--data-dir', dir, '--log-dir', cfg.logDir, '--port', String(cfg.server.port), '--web-dir', web,
      ], { cwd: installed ?? process.cwd(), detached: true, stdio: ['ignore', log, log], windowsHide: true });
    } finally { closeSync(log); }
    let launchError: Error | undefined;
    child.once('error', error => { launchError = error; });
    child.unref();
    let ready = false;
    for (let i = 0; i < 35; i++) {
      const state = await health(url);
      if (state?.instanceId && state.instanceId === lock(dir)?.instanceId) { ready = true; break; }
      if (child.exitCode !== null || launchError) break;
      await delay(250);
    }
    if (!ready) throw new Error(`启动失败，请查看 ${path}`);
    console.log(`日志目录 ${cfg.logDir}`);
  }
  console.log(`Runember 运行于 ${url}`);
  console.log(`数据目录 ${dir}`);
  if (browser) openBrowser(url);
}

export async function stopDaemon(cfg: AppConfig, token: string): Promise<void> {
  const info = lock(cfg.dataDir);
  const url = localAddress(cfg);
  const state = await health(url);
  if (!state) { console.log('daemon 当前未运行。'); return; }
  if (!info?.key || !info.instanceId || info.instanceId !== state.instanceId) {
    throw new Error('当前地址的 daemon 不属于所选数据目录。');
  }
  const res = await fetch(url + '/api/shutdown', {
    method: 'POST', signal: AbortSignal.timeout(3_000),
    headers: { 'x-agentdesk-control': info.key, 'x-agentdesk-token': token },
  });
  if (!res.ok) throw new Error(`请求停机失败（HTTP ${res.status}）。`);
  console.log('已请求停机。daemon 会等待活动任务结束。');
}
