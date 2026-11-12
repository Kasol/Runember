/**
 * 宿主侧 git —— git 元数据操作的唯一执行地。
 *
 * 设计公理（2026-11-12 事故后确立）：容器与宿主是两个不同的 git 运行环境
 * （不同程序版本/配置/LFS hook），让容器里的 git 写用户仓库 = 赌两环境一致。
 * 故 checkpoint/审计等一切 git 写操作移到宿主 daemon 执行，容器只改工作树文件。
 *
 * 附带收益：
 *  - 用宿主 git = 天然继承用户的 LFS 配置/hook（昨晚 LFS 裸奔事故根治）
 *  - .git 不再被容器触碰 → "只读阻塞"问题根治
 *  - filemode/autocrlf 由 daemon 注册项目时统一设置 → 用户零心智负担
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const pExecFile = promisify(execFile);

export interface HostGitResult { ok: boolean; stdout: string; stderr: string }

/** 宿主 git 是否可用（doctor / project add 时检测） */
export async function hostGitAvailable(): Promise<{ ok: boolean; version: string }> {
  try {
    const { stdout } = await pExecFile('git', ['--version'], { timeout: 10_000 });
    return { ok: true, version: stdout.trim() };
  } catch {
    return { ok: false, version: '' };
  }
}

async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<HostGitResult> {
  try {
    const { stdout, stderr } = await pExecFile('git', args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { ok: true, stdout, stderr };
  } catch (e: any) {
    // execFile 失败时 e.stdout/stderr 仍带有部分输出
    return { ok: false, stdout: e?.stdout ?? '', stderr: e?.stderr ?? e?.message ?? String(e) };
  }
}

/** 目录是否为 git 仓库 */
export function isGitRepo(projectPath: string): boolean {
  return existsSync(join(projectPath, '.git'));
}

/**
 * 注册项目时的仓库级 git 配置（写进 <项目>/.git/config，不动用户全局配置）。
 * 目的：宿主/容器/工具链跨视角协作时消除权限位与换行符噪音。
 */
export async function setupProjectGit(projectPath: string): Promise<{ ok: boolean; message: string }> {
  if (!isGitRepo(projectPath)) return { ok: true, message: '非 git 仓库，跳过配置' };
  const r = await git(projectPath, [
    'config', 'core.filemode', 'false',
  ]);
  return r.ok
    ? { ok: true, message: 'git 仓库配置已优化（core.filemode=false）' }
    : { ok: false, message: `git 配置失败: ${r.stderr.slice(0, 120)}` };
}

export interface CheckpointResult {
  ok: boolean;
  /** checkpoint 提交的 commit hash（用于任务后 diff 审计）；NO-GIT 表示非仓库 */
  anchor: string;
  error?: string;
}

/**
 * 任务前 checkpoint：把当前工作树（含用户未提交 WIP）钉成回滚锚点。
 * 在宿主执行 → LFS/filemode 配置天然生效，是用户 git 环境的一部分。
 */
export async function hostCheckpoint(projectPath: string, taskId: number): Promise<CheckpointResult> {
  if (!isGitRepo(projectPath)) return { ok: true, anchor: 'NO-GIT' };
  // 幂等：先 add+commit（无改动时 commit 会失败，属正常），再取 HEAD
  const add = await git(projectPath, ['add', '-A']);
  if (!add.ok) return { ok: false, anchor: '', error: `git add 失败: ${add.stderr.slice(0, 150)}` };
  await git(projectPath, [
    'commit', '-qm', `agentdesk: pre-task checkpoint (task-${taskId})`,
    '--no-verify',
  ]);
  const head = await git(projectPath, ['rev-parse', 'HEAD']);
  if (!head.ok) return { ok: false, anchor: '', error: `git rev-parse 失败: ${head.stderr.slice(0, 150)}` };
  return { ok: true, anchor: head.stdout.trim() };
}

export interface AuditResult {
  filesChanged: string[];
  diffStat: string;
}

/** 任务后审计：相对 checkpoint 的改动清单与统计（宿主侧执行） */
export async function hostAudit(projectPath: string, anchor: string): Promise<AuditResult> {
  if (!isGitRepo(projectPath) || !anchor || anchor === 'NO-GIT') return { filesChanged: [], diffStat: '' };
  const st = await git(projectPath, ['status', '--porcelain']);
  const df = await git(projectPath, ['diff', '--stat', `${anchor}..HEAD`]);
  return {
    filesChanged: st.stdout.split('\n').map(s => s.trim()).filter(Boolean),
    diffStat: df.stdout.trim(),
  };
}
