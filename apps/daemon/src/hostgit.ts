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
import { existsSync, mkdtempSync, unlinkSync, rmdirSync, accessSync, constants, statSync } from 'node:fs';
import { join, delimiter, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
const pExecFile = promisify(execFile);

export interface HostGitResult { ok: boolean; stdout: string; stderr: string }

/** 宿主 git 是否可用（doctor / project add 时检测） */
export async function hostGitAvailable(): Promise<{ ok: boolean; version: string; path?: string }> {
  try {
    const { stdout } = await pExecFile('git', ['--version'], { timeout: 10_000, windowsHide: true });
    const executable = process.platform === 'win32' ? 'git.exe' : 'git';
    const path = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => resolve(dir.replace(/^"|"$/g, ''), executable))
      .find(file => { try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; } });
    return { ok: true, version: stdout.trim(), path };
  } catch {
    return { ok: false, version: '' };
  }
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<HostGitResult> {
  try {
    const { stdout, stderr } = await pExecFile('git', args, {
      cwd,
      timeout: 60_000,
      env,
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
  gitOperation?: string;
}

function activeOperationIn(gitDir: string): string | undefined {
  return ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'sequencer']
    .find(marker => existsSync(join(gitDir, marker)));
}

/** 检查任务结束后，当前工作树是否还留有正在进行的 Git 操作。 */
export async function hostGitOperation(projectPath: string): Promise<string | undefined> {
  if (!isGitRepo(projectPath)) return undefined;
  const gitDir = await git(projectPath, ['rev-parse', '--absolute-git-dir']);
  return gitDir.ok ? activeOperationIn(gitDir.stdout.trim()) : undefined;
}

async function worktreeTree(projectPath: string, base: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-index-'));
  const index = join(dir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    await checkedGit(projectPath, ['read-tree', base], env);
    await checkedGit(projectPath, ['add', '-A'], env);
    return await checkedGit(projectPath, ['write-tree'], env);
  } finally {
    try { unlinkSync(index); } catch { /* 文件可能还未创建 */ }
    try { rmdirSync(dir); } catch { /* 保留尚有锁的临时目录 */ }
  }
}

async function checkedGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await git(cwd, args, env);
  if (!result.ok) throw new Error(`git ${args[0]} 失败: ${result.stderr.trim().slice(0, 200)}`);
  return result.stdout.trim();
}

/**
 * 用临时索引和独立引用记录工作树快照，保留当前分支和真实暂存区。
 */
export async function hostCheckpoint(projectPath: string, taskId: number): Promise<CheckpointResult> {
  if (!isGitRepo(projectPath)) return { ok: true, anchor: 'NO-GIT' };
  const failure = (error: string): CheckpointResult => ({ ok: false, anchor: '', error });
  const gitDir = await git(projectPath, ['rev-parse', '--absolute-git-dir']);
  if (!gitDir.ok) return failure(gitDir.stderr);
  const gitOperation = activeOperationIn(gitDir.stdout.trim());
  if (gitOperation) return { ...failure(`Git 操作进行中（${gitOperation}）`), gitOperation };
  const head = await git(projectPath, ['rev-parse', 'HEAD']);
  if (!head.ok) return failure(`无法确定当前 HEAD: ${head.stderr.slice(0, 150)}`);
  const anchor = head.stdout.trim();
  const exec = (...args: string[]) => checkedGit(projectPath, args);
  try {
    const tree = await worktreeTree(projectPath, anchor);
    if (await exec('rev-parse', 'HEAD') !== anchor) return failure('创建快照期间 HEAD 已变化');
    if (tree === await exec('rev-parse', `${anchor}^{tree}`)) return { ok: true, anchor };
    const commit = await exec('commit-tree', tree, '-p', anchor, '-m', `agentdesk: pre-task checkpoint (task-${taskId})`);
    await exec('update-ref', `refs/agentdesk/checkpoints/task-${taskId}/${randomUUID()}`, commit);
    return { ok: true, anchor: commit };
  } catch (error) {
    return failure((error as Error).message);
  }
}

export interface AuditResult {
  filesChanged: string[];
  diffStat: string;
}

/** 任务后审计：相对 checkpoint 的改动清单与统计（宿主侧执行） */
export async function hostAudit(projectPath: string, anchor: string): Promise<AuditResult> {
  if (!isGitRepo(projectPath) || !anchor || anchor === 'NO-GIT') return { filesChanged: [], diffStat: '' };
  const tree = await worktreeTree(projectPath, 'HEAD');
  const st = await checkedGit(projectPath, ['diff', '--name-status', anchor, tree, '--']);
  const df = await checkedGit(projectPath, ['diff', '--stat', anchor, tree, '--']);
  return {
    filesChanged: st.split('\n').filter(Boolean),
    diffStat: df,
  };
}
