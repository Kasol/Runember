/**
 * NativeBackend —— codex 直接跑宿主进程（无容器）。
 *
 * 适用场景（project add 时按项目选择 execution: 'capability' | 'isolation'，默认 capability）：
 *  - 个人开发机、想原生速度（无 bind mount 性能损耗）
 *  - skills/auth/配置全部原生，零播种
 *
 * 代价（已在产品文档明示）：agent 以你的用户身份直接操作本机，
 * 安全边界退化为 codex 自身 sandbox + 提示词约定。
 *
 * 实现：spawn 宿主 codex 进程（stdin 关闭防挂起、超时 kill、日志同管道），
 * 事件解析/状态机/通知全部复用（同 AgentAdapter 接口）。
 */
import { execFile, spawn as nodeSpawn, ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, join, resolve as resolvePath } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AppConfig } from './config.js';

/**
 * 宿主 codex CLI 发现：
 *  1. PATH 上的 codex（用户自装优先，如 npm -g）
 *  2. GUI 私有运行时：%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe 取最新
 *     （GUI 故意不注入 PATH——内核版本由 GUI 自管；哈希目录随升级变化，
 *      所以每次发现而非硬编码。结果带缓存，进程内复用。）
 */
let codexPathCache: string | undefined;

export function findHostCodex(): string | undefined {
  if (process.env.AGENTDESK_CODEX_PATH) {
    const path = resolvePath(process.env.AGENTDESK_CODEX_PATH);
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile() ? path : undefined;
    } catch { return undefined; }
  }
  if (codexPathCache && existsSync(codexPathCache)) return codexPathCache;
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const path = resolvePath(dir.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'codex.exe' : 'codex');
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return (codexPathCache = path);
    } catch { /* 尝试下一个 PATH 目录 */ }
  }

  const localAppData = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
  const guiBinRoot = join(localAppData, 'OpenAI', 'Codex', 'bin');
  if (existsSync(guiBinRoot)) {
    let best: { path: string; mtime: number } | undefined;
    for (const hash of readdirSync(guiBinRoot)) {
      const exe = join(guiBinRoot, hash, 'codex.exe');
      if (!existsSync(exe)) continue;
      const mtime = statSync(exe).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: exe, mtime };
    }
    if (best) { codexPathCache = best.path; return codexPathCache; }
  }
  return undefined;
}

export function hostCodexProxyEnv(proxy: AppConfig['proxy']): string[] {
  const https = proxy.nativeHttpsProxy || proxy.httpsProxy;
  const http = proxy.nativeHttpProxy || proxy.httpProxy;
  return [
    ...(https ? [`HTTPS_PROXY=${https}`, `https_proxy=${https}`] : []),
    ...(http ? [`HTTP_PROXY=${http}`, `http_proxy=${http}`] : []),
  ];
}

export async function hostCodexLoginStatus(path: string, proxy: AppConfig['proxy']): Promise<NativeProc> {
  return runNative({ cmd: [path, 'login', 'status'], cwd: process.cwd(), env: hostCodexProxyEnv(proxy), timeoutMs: 10_000 });
}

export async function loginHostCodex(path: string, proxy: AppConfig['proxy'], deviceAuth: boolean): Promise<number> {
  const env = { ...process.env };
  for (const value of hostCodexProxyEnv(proxy)) {
    const i = value.indexOf('=');
    env[value.slice(0, i)] = value.slice(i + 1);
  }
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(path, deviceAuth ? ['login', '--device-auth'] : ['login'], { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
}

export interface NativeProc {
  exitCode: number | null;
  killed: boolean;
  out: string[];
  err: string[];
}

export interface NativeSpawnOpts {
  cmd: string[];
  cwd: string;
  env?: string[];
  timeoutMs: number;
  onStdoutLine?: (line: string) => void;
  logFile?: string;
}

/** 宿主侧执行（与 DockerBackend 的 runInRunner 语义对齐：超时强杀、收集输出） */
export function runNative(opts: NativeSpawnOpts, onProc?: (p: ChildProcess) => void): Promise<NativeProc> {
  const { cmd, cwd, env, timeoutMs, onStdoutLine } = opts;
  return new Promise(resolve => {
    const out: string[] = [];
    const err: string[] = [];
    let killed = false;

    // stdin: 'ignore' —— codex 探测到 stdin 关闭不会挂起等待（M1 教训）
    const child = nodeSpawn(cmd[0]!, cmd.slice(1), {
      cwd,
      env: env?.length ? { ...process.env, ...Object.fromEntries(env.map(pair => {
        const split = pair.indexOf('=');
        return [pair.slice(0, split), pair.slice(split + 1)];
      })) } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
    });
    onProc?.(child);

    const collect = (source: Readable | null, target: string[], onLine?: (l: string) => void): (() => void) => {
      let buf = '';
      const decoder = new StringDecoder('utf8');
      const emit = (line: string) => {
        if (!line.trim()) return;
        target.push(line);
        onLine?.(line);
      };
      source?.on('data', (chunk: Buffer) => {
        buf += decoder.write(chunk);
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          emit(buf.slice(0, nl).replace(/\r+$/, ''));
          buf = buf.slice(nl + 1);
        }
      });
      return () => {
        source?.destroy();
        emit(buf + decoder.end());
      };
    };
    const flushStdout = collect(child.stdout, out, onStdoutLine);
    const flushStderr = collect(child.stderr, err);

    let settled = false;
    let drainTimer: NodeJS.Timeout | undefined;
    const timer = timeoutMs > 0 ? setTimeout(() => { killed = true; killProcessTree(child); }, timeoutMs) : undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      flushStdout();
      flushStderr();
      resolve({ exitCode: code, killed, out, err });
    };
    child.once('exit', code => {
      clearTimeout(timer);
      // A background descendant may inherit the pipes and keep 'close' from firing.
      drainTimer = setTimeout(() => finish(code), 1_000);
    });
    child.once('close', finish);
    child.once('error', e => {
      err.push(`spawn 失败: ${e.message}`);
      finish(null);
    });
  });
}

export function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
      if (error) child.kill('SIGKILL');
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
