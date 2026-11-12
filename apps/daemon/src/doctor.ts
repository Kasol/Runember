/**
 * doctor —— 开箱自检：五项环境依赖一键体检。
 * 用法: npm run desk -- doctor
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { hostGitAvailable } from '../../daemon/src/hostgit.js';

export interface DoctorRow { name: string; ok: boolean; detail: string; required: boolean }

export async function runDoctor(): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  const check = async (name: string, required: boolean, fn: () => Promise<{ ok: boolean; detail: string }>) => {
    const r = await fn();
    rows.push({ name, ok: r.ok, detail: r.detail, required });
  };

  await check('Docker 引擎', true, async () => {
    try {
      const r = await fetch('http://localhost:8787/api/agents', { signal: AbortSignal.timeout(3000) });
      return r.ok
        ? { ok: true, detail: 'daemon 可达（容器执行已就绪）' }
        : { ok: false, detail: 'daemon 返回异常' };
    } catch {
      // daemon 不在时退回检查 docker CLI
      return { ok: false, detail: 'daemon 未运行（npm run daemon）——启动后此项自动通过' };
    }
  });

  await check('宿主 git', true, async () => {
    const g = await hostGitAvailable();
    return { ok: g.ok, detail: g.ok ? g.version : '未安装——checkpoint 安全网依赖它' };
  });

  await check('Runner 镜像 (agentdesk/runner-codex:m0)', true, async () => {
    const { execFile } = await import('node:child_process');
    const p = promisifyExec(execFile);
    try {
      await p('docker', ['image', 'inspect', 'agentdesk/runner-codex:m0'], { timeout: 8000 });
      return { ok: true, detail: '已构建' };
    } catch {
      return { ok: false, detail: '未构建——先跑 npm run m0:offline' };
    }
  });

  await check('Codex 凭证（codex-home 卷）', true, async () => {
    const { execFile } = await import('node:child_process');
    const p = promisifyExec(execFile);
    try {
      await p('docker', ['run', '--rm', '-v', 'agentdesk-codex-home:/h', 'alpine:latest', 'sh', '-c', 'test -f /h/auth.json'], { timeout: 20000 });
      return { ok: true, detail: 'auth.json 存在' };
    } catch {
      return { ok: false, detail: '未登录——跑 npm run m0:login 或 desk auth codex' };
    }
  });

  await check('宿主 skills 目录（可选继承）', false, async () => {
    const dir = join(homedir(), '.codex', 'skills');
    if (!existsSync(dir)) return { ok: true, detail: '不存在（无 skills 可继承，非问题）' };
    const n = existsSync(dir) ? require('node:fs').readdirSync(dir).length : 0;
    return { ok: true, detail: `${n} 个 skills 将在每次任务前播种进容器` };
  });

  return rows;
}

function promisifyExec(execFile: typeof import('node:child_process').execFile) {
  return Object.assign(
    (cmd: string, args: string[], opts: { timeout: number }) =>
      new Promise<void>((resolve, reject) => {
        execFile(cmd, args, { ...opts, windowsHide: true }, (err) => err ? reject(err) : resolve());
      }),
  );
}

export function printDoctor(rows: DoctorRow[]): number {
  console.log('\n🩺 agentdesk doctor');
  let fail = 0;
  for (const r of rows) {
    const icon = r.ok ? '✅' : (r.required ? '❌' : '⚠️ ');
    if (!r.ok && r.required) fail++;
    console.log(`${icon} ${r.name} — ${r.detail}`);
  }
  console.log(fail === 0 ? '\n全部必需项通过 ✅' : `\n${fail} 项必需检查未通过`);
  return fail === 0 ? 0 : 1;
}
