import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import type { AppConfig } from './config.js';
import type { Store } from './store.js';

type Settings = Pick<Store, 'getSetting'>;
const key = 'network.nativeProxy';

export function validateNativeProxy(value: unknown): string {
  if (typeof value !== 'string') throw new Error('代理地址必须为字符串。');
  if (!value.trim()) return '';
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('请输入完整 HTTP/HTTPS 代理地址，例如 http://127.0.0.1:7897。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('代理地址仅支持 HTTP/HTTPS 的主机和端口，不包含账号、密码、路径或查询参数。');
  }
  return url.origin;
}

export function applyNetworkSettings(cfg: AppConfig, store: Settings): AppConfig {
  const saved = store.getSetting(key);
  if (!saved) return cfg;
  const url = validateNativeProxy(saved);
  return { ...cfg, proxy: { ...cfg.proxy, nativeHttpsProxy: url, nativeHttpProxy: url } };
}

function safeProxy(value?: string): string | undefined {
  if (!value) return;
  try { const url = new URL(value); url.username = ''; url.password = ''; return url.origin; } catch { return '启动环境已配置代理'; }
}

export function networkSettings(cfg: AppConfig, store: Settings) {
  const saved = store.getSetting(key) || '';
  const actual = applyNetworkSettings(cfg, store).proxy;
  const https = safeProxy(actual.nativeHttpsProxy || actual.httpsProxy || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy);
  const http = safeProxy(actual.nativeHttpProxy || actual.httpProxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy);
  return { mode: saved ? 'custom' as const : 'inherit' as const, url: safeProxy(saved) || '', httpsProxy: https, httpProxy: http };
}

export function saveNetworkSettings(store: Pick<Store, 'setSetting'>, value: unknown): void {
  store.setSetting(key, validateNativeProxy(value));
}

/** No credentials or model request. A 401/403 is an HTTP response, not an authentication test. */
export async function testNativeConnection(cfg: AppConfig, execute = promisify(execFile)) {
  const target = 'https://chatgpt.com/backend-api/codex/models';
  const proxy = cfg.proxy.nativeHttpsProxy || cfg.proxy.httpsProxy;
  const args = ['--connect-timeout', '5', '--max-time', '10', '--silent', '--show-error', '--output',
    process.platform === 'win32' ? 'NUL' : '/dev/null', '--write-out', '%{http_code}\t%{time_total}', target];
  const executable = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:/Windows', 'System32', 'curl.exe') : '/usr/bin/curl';
  try {
    const env = proxy ? { ...process.env, HTTPS_PROXY: proxy, https_proxy: proxy } : process.env;
    const { stdout } = await execute(executable, args, { env, windowsHide: true, timeout: 12_000, maxBuffer: 4096 });
    const [code, time] = stdout.trim().split('\t');
    const httpStatus = Number(code);
    const ok = httpStatus > 0 && httpStatus !== 407;
    return { ok, target, httpStatus, elapsedMs: Math.round(Number(time) * 1000),
      message: httpStatus === 407 ? '代理要求认证，请使用当前账号可直接连接的代理入口。'
        : `Codex 服务已响应（HTTP ${httpStatus}）。本检测未携带凭证，账号和模型仍需实际任务验证。` };
  } catch (error) {
    const e = error as Error & { code?: number | string };
    return { ok: false, target, message: e.code === 'ENOENT' ? '未找到系统 curl，无法执行连接检测。' : '连接失败或超时，请检查代理地址、代理进程及网络。' };
  }
}
