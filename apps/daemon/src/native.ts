/**
 * NativeBackend —— codex 直接跑宿主进程（无容器）。
 *
 * 适用场景（project add 时按项目选择 execution: 'docker' | 'native'，默认 docker）：
 *  - 个人开发机、想原生速度（无 bind mount 性能损耗）
 *  - skills/auth/配置全部原生，零播种
 *
 * 代价（已在产品文档明示）：agent 以你的用户身份直接操作本机，
 * 安全边界退化为 codex 自身 sandbox + 提示词约定。
 *
 * 实现：spawn 宿主 codex 进程（stdin 关闭防挂起、超时 kill、日志同管道），
 * 事件解析/状态机/通知全部复用（同 AgentAdapter 接口）。
 */
import { spawn as nodeSpawn, ChildProcess } from 'node:child_process';
import { Writable } from 'node:stream';

export interface NativeProc {
  exitCode: number;
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
      env: env?.length ? { ...process.env, ...Object.fromEntries(env.map(e => e.split('='))) } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    onProc?.(child);

    const sink = (target: string[], onLine?: (l: string) => void): Writable => {
      let buf = '';
      const w = new Writable({
        write(chunk, _enc, cb) {
          buf += chunk.toString('utf8');
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).replace(/\r+$/, '');
            buf = buf.slice(nl + 1);
            if (line.trim()) { target.push(line); onLine?.(line); }
          }
          cb();
        },
        final(cb) { if (buf.trim()) target.push(buf); cb(); },
      });
      return w;
    };
    child.stdout?.pipe(sink(out, onStdoutLine));
    child.stderr?.pipe(sink(err));

    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, killed, out, err });
    });
    child.on('error', e => {
      clearTimeout(timer);
      err.push(`spawn 失败: ${e.message}`);
      resolve({ exitCode: -1, killed, out, err });
    });
  });
}
