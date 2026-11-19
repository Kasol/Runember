import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { killProcessTree } from './native.js';

export interface MergePlan {
  source: string;
  base: string;
  test: string;
  retireDev: boolean;
}

export interface MergeState {
  repo?: string;
  sourceSha?: string;
  localSource?: boolean;
  sync?: string;
  preparing?: { base: string; from: string; upstream: string };
  verified?: { base: string; head: string };
  published?: string;
  pr?: number;
  blockedSince?: number;
  completed?: string;
}

interface PullRequest {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  baseRefName: string;
  baseRefOid: string;
  headRefName: string;
  headRefOid: string;
  isCrossRepository: boolean;
  mergeCommit: { oid: string } | null;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision: string;
  statusCheckRollup: Array<{ status?: string; state?: string }> | null;
}

export type MergeResult = { status: 'succeeded' | 'blocked' | 'waiting'; message: string };

export class MergeBlocked extends Error {}
const exec = promisify(execFile);
const prFields = 'number,url,state,baseRefName,baseRefOid,headRefName,headRefOid,isCrossRepository,mergeCommit,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup';

export function ghExecutable(): string {
  const portable = fileURLToPath(new URL('../../../data/tools/gh.exe', import.meta.url));
  return process.env.AGENTDESK_GH_PATH || (existsSync(portable) ? portable : 'gh');
}

async function command(cwd: string, binary: string, args: string[]): Promise<string> {
  const proxy = process.env.AGENTDESK_MERGE_HTTPS_PROXY;
  try {
    const operation = exec(binary, args, {
      cwd, timeout: 90_000, windowsHide: true,
      env: {
        ...process.env,
        ...(proxy ? { HTTPS_PROXY: proxy, https_proxy: proxy } : {}),
        GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GH_PROMPT_DISABLED: '1',
      },
    });
    operation.child.stdin?.end();
    const result = await operation;
    return result.stdout.trim();
  } catch (error) {
    const failure = error as { stderr?: string; code?: string };
    const detail = (failure.stderr?.trim() || failure.code || '超时或进程退出')
      .replace(/(https?:\/\/)[^\s/@]+@/g, '$1[redacted]@').slice(-1500);
    throw new MergeBlocked(`${binary === 'git' ? 'git' : 'gh'} ${args[0]}: ${detail}`);
  }
}

function githubRepo(remote: string): string {
  const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+)$/i);
  if (!match) throw new MergeBlocked('origin 必须是 github.com 仓库，凭证请通过 Git 凭证管理器或 SSH 配置');
  return match[1]!.replace(/\.git$/i, '').toLowerCase();
}

function runTests(cwd: string, test: string, timeout: number, log: (line: string) => void, onPid?: (pid: number) => void): Promise<void> {
  return new Promise((resolveTest, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(test, { cwd, shell: true, windowsHide: true, detached: !windows, stdio: ['ignore', 'pipe', 'pipe'] });
    if (child.pid) onPid?.(child.pid);
    let timedOut = false;
    child.stdout.on('data', chunk => log(String(chunk)));
    child.stderr.on('data', chunk => log(String(chunk)));
    const timer = timeout > 0 ? setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeout) : undefined;
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new MergeBlocked('全量测试超时，详见运行日志'));
      else if (code === 0) resolveTest();
      else reject(new MergeBlocked(`全量测试失败（退出码 ${code}），详见运行日志`));
    });
  });
}

export async function runMerge(options: {
  cwd: string;
  worktree: string;
  plan: MergePlan;
  state: MergeState;
  save: (state: MergeState) => void;
  log: (line: string) => void;
  testTimeout: number;
  onTestPid?: (pid: number) => void;
}): Promise<MergeResult> {
  const { cwd, worktree, plan, state, save, log, testTimeout } = options;
  const git = (...args: string[]) => command(cwd, 'git', args);
  const work = (...args: string[]) => command(worktree, 'git', args);
  const sourceRef = `refs/heads/${plan.source}`;
  const baseRef = `refs/heads/${plan.base}`;
  const remote = async (ref: string) => (await git('ls-remote', '--refs', 'origin', ref)).split(/\s/)[0] || undefined;
  const localSource = async () => (await git('for-each-ref', '--format=%(refname) %(objectname)', sourceRef))
    .split('\n').find(line => line.startsWith(sourceRef + ' '))?.split(' ')[1];
  const wait = (message: string): MergeResult => ({ status: 'waiting', message });
  const expectClean = async () => {
    if (await work('status', '--porcelain')) throw new MergeBlocked(`合并工作树有未提交改动，请检查 ${worktree}`);
  };

  if (state.completed) return { status: 'succeeded', message: state.completed };
  await git('check-ref-format', sourceRef);
  await git('check-ref-format', baseRef);
  const repo = githubRepo(await git('remote', 'get-url', 'origin'));
  if (repo !== githubRepo(await git('remote', 'get-url', '--push', 'origin')) || (state.repo && state.repo !== repo)) {
    throw new MergeBlocked('origin 的读取、推送或任务记录指向不同的 GitHub 仓库');
  }
  const gh = (...args: string[]) => command(cwd, ghExecutable(), args);
  const ghRepo = `github.com/${repo}`;
  const view = async (id: number): Promise<PullRequest> =>
    JSON.parse(await gh('pr', 'view', String(id), '--repo', ghRepo, '--json', prFields));
  const findPr = async (): Promise<PullRequest | undefined> => {
    const candidates: PullRequest[] = JSON.parse(await gh('pr', 'list', '--repo', ghRepo, '--state', 'all',
      '--base', plan.base, '--head', state.sync!, '--json', prFields));
    const matches = candidates.filter(candidate => !candidate.isCrossRepository && candidate.headRefName === state.sync);
    if (matches.length > 1) throw new MergeBlocked('同一同步分支匹配多个 PR，请核查远端状态');
    return matches[0];
  };
  const checkPr = (pr: PullRequest, head: string) => {
    if (pr.baseRefName !== plan.base || pr.headRefName !== state.sync || pr.headRefOid !== head || pr.isCrossRepository) {
      throw new MergeBlocked(`PR 的分支或提交与已验证版本不符。 ${pr.url}`);
    }
  };

  if (!state.sourceSha) {
    await gh('repo', 'view', ghRepo, '--json', 'nameWithOwner');
    const local = await localSource();
    const source = local ?? await remote(sourceRef);
    if (!source) throw new MergeBlocked(`找不到源分支 ${plan.source}`);
    if (!local) await git('fetch', '--no-tags', 'origin', source);
    Object.assign(state, { repo, sourceSha: source, localSource: !!local, sync: `agentdesk-sync-${randomUUID()}` });
    save(state);
  }
  const syncRef = `refs/heads/${state.sync}`;
  const fetchBase = async () => {
    const sha = await remote(baseRef);
    if (!sha) throw new MergeBlocked(`远端目标分支 ${plan.base} 不存在`);
    await git('fetch', '--no-tags', 'origin', sha);
    return sha;
  };
  const finish = async (pr: PullRequest): Promise<MergeResult> => {
    const head = state.verified!.head;
    checkPr(pr, head);
    const tip = await fetchBase();
    try {
      if (!pr.mergeCommit) throw new Error('missing merge commit');
      await git('merge-base', '--is-ancestor', pr.mergeCommit.oid, tip);
      const mergedTree = await git('rev-parse', `${pr.mergeCommit.oid}^{tree}`);
      if (mergedTree !== await git('rev-parse', `${head}^{tree}`)) throw new Error('tree mismatch');
    } catch {
      throw new MergeBlocked(`PR 已合并，但远端合并结果尚未核对为已测试文件树。保留分支供核查。 ${pr.url}`);
    }
    const notes: string[] = [];
    const deleteRemote = async (ref: string, expected: string) => {
      const found = await remote(ref);
      if (!found) return;
      if (found !== expected) { notes.push(`保留已前移的远端 ${ref}`); return; }
      await git('push', '--no-follow-tags', '--recurse-submodules=no', `--force-with-lease=${ref}:${expected}`, 'origin', `:${ref}`);
    };
    await deleteRemote(syncRef, head);
    if (plan.retireDev) {
      await deleteRemote(sourceRef, state.sourceSha!);
      if (await localSource() === state.sourceSha) {
        const checkouts = await git('worktree', 'list', '--porcelain');
        if (checkouts.split('\n').includes(`branch ${sourceRef}`)) {
          notes.push(`本地 ${plan.source} 正在使用，已保留`);
        } else {
          await git('update-ref', '-d', sourceRef, state.sourceSha!);
        }
      } else if (await localSource()) notes.push(`保留已前移的本地 ${plan.source}`);
    }
    if (existsSync(worktree)) await git('worktree', 'remove', worktree);
    state.completed = [`Rebase 合并已验证 ${pr.url}`, `测试通过 ${head}`, ...notes].join('\n');
    save(state);
    return { status: 'succeeded', message: state.completed };
  };

  let pr = state.pr ? await view(state.pr) : state.published ? await findPr() : undefined;
  if (pr && !state.pr) {
    checkPr(pr, state.published!);
    state.pr = pr.number;
    save(state);
  }
  if (pr?.state === 'MERGED') return finish(pr);
  if (pr?.state === 'CLOSED') throw new MergeBlocked(`本任务的 PR 已关闭。 ${pr.url}`);
  const base = await fetchBase();
  if (!existsSync(worktree)) {
    mkdirSync(dirname(worktree), { recursive: true });
    await git('worktree', 'add', '--detach', worktree, state.verified?.head ?? state.sourceSha!);
  }
  const inProgress = await work('rev-parse', '--git-path', 'rebase-merge');
  const applyProgress = await work('rev-parse', '--git-path', 'rebase-apply');
  if ([inProgress, applyProgress].some(path => existsSync(isAbsolute(path) ? path : resolve(worktree, path)))) {
    throw new MergeBlocked(`rebase 等待冲突处理，请在 ${worktree} 解决并执行 git rebase --continue，再重试此任务`);
  }
  await expectClean();

  while (!state.verified || state.verified.base !== base || state.preparing) {
    if (!state.preparing) {
      const from = state.verified?.head ?? state.sourceSha!;
      const upstream = state.verified?.base ?? await work('merge-base', from, base);
      state.preparing = { base, from, upstream };
      save(state);
    }
    const preparation = state.preparing;
    log(`rebase ${preparation.from} onto ${preparation.base}\n`);
    if (await work('rev-parse', 'HEAD') === preparation.from) {
      try {
        await work('rebase', '--no-autostash', '--no-update-refs', '--no-autosquash',
          '--rebase-merges', '--onto', preparation.base, preparation.upstream);
      } catch (error) {
        throw new MergeBlocked(`${(error as Error).message}\n合并工作树在 ${worktree}。解决冲突并继续 rebase 后重试。`);
      }
    }
    const head = await work('rev-parse', 'HEAD');
    await work('merge-base', '--is-ancestor', preparation.base, head);
    if (head === preparation.base) throw new MergeBlocked('源分支没有需要合入的提交');
    await work('diff', '--check', preparation.base, head);
    log(`全量测试 ${head}\n`);
    await runTests(worktree, plan.test, testTimeout, log, options.onTestPid);
    await expectClean();
    if (head !== await work('rev-parse', 'HEAD')) throw new MergeBlocked('测试期间 HEAD 发生变化');
    state.verified = { base: preparation.base, head };
    delete state.preparing;
    save(state);
  }

  const head = state.verified.head;
  if (await work('rev-parse', 'HEAD') !== head) throw new MergeBlocked('合并工作树 HEAD 与测试记录不符');
  if (await remote(baseRef) !== base) return wait('远端目标分支已更新，将重新对齐并验证');
  const published = await remote(syncRef);
  if (published !== head) {
    if (published !== state.published) throw new MergeBlocked('远端同步分支已被其他操作改动');
    await git('push', '--no-follow-tags', '--recurse-submodules=no',
      `--force-with-lease=${syncRef}:${published ?? ''}`, 'origin', `${head}:${syncRef}`);
  }
  if (await remote(syncRef) !== head) throw new MergeBlocked('推送后同步分支与测试记录不符');
  state.published = head;
  save(state);

  if (!pr) {
    pr = await findPr();
    if (!pr) {
      await gh('pr', 'create', '--repo', ghRepo, '--base', plan.base, '--head', state.sync!,
        '--title', `Merge ${plan.source} into ${plan.base}`, '--body',
        `Source: ${plan.source} @ ${state.sourceSha}\n\nInitial verification: full tests and git diff --check passed on ${head}.`);
      return wait('PR 已创建，下一轮核对 PR 与检查状态');
    }
    checkPr(pr, head);
    state.pr = pr.number;
    save(state);
  } else {
    pr = await view(pr.number);
  }
  checkPr(pr, head);
  if (pr.state === 'MERGED') return finish(pr);
  if (pr.state !== 'OPEN') throw new MergeBlocked(`PR 当前为 ${pr.state}。 ${pr.url}`);
  if (pr.baseRefOid !== base || await remote(baseRef) !== base) return wait(`等待核对远端 base。 ${pr.url}`);
  if (pr.reviewDecision === 'REVIEW_REQUIRED' || pr.reviewDecision === 'CHANGES_REQUESTED') {
    throw new MergeBlocked(`PR 需要人工审批或修改。 ${pr.url}`);
  }
  if (pr.mergeable === 'UNKNOWN' || pr.mergeStateStatus === 'UNKNOWN' ||
      pr.statusCheckRollup?.some(check => (check.status && check.status !== 'COMPLETED') ||
        check.state === 'PENDING' || check.state === 'EXPECTED')) {
    return wait(`等待 GitHub 计算合并状态或运行检查。 ${pr.url}`);
  }
  if (pr.mergeStateStatus === 'BLOCKED') {
    if (!state.blockedSince) {
      state.blockedSince = Date.now();
      save(state);
    }
    if (Date.now() - state.blockedSince < 120_000) return wait(`等待 GitHub 更新检查结果。 ${pr.url}`);
  }
  if (pr.mergeable !== 'MERGEABLE' || !['CLEAN', 'HAS_HOOKS', 'UNSTABLE'].includes(pr.mergeStateStatus)) {
    throw new MergeBlocked(`GitHub 暂不允许合并（${pr.mergeStateStatus}）。 ${pr.url}`);
  }
  try {
    const outcome = JSON.parse(await gh('api', '--hostname', 'github.com', '-X', 'PUT', `repos/${repo}/pulls/${pr.number}/merge`,
      '-f', 'merge_method=rebase', '-f', `sha=${head}`));
    if (!outcome.merged) throw new MergeBlocked(outcome.message);
  } catch (error) {
    const latest = await view(pr.number);
    if (latest.state === 'MERGED') return finish(latest);
    if (latest.baseRefOid !== base) return wait(`远端目标分支已更新。 ${pr.url}`);
    throw new MergeBlocked(`${(error as Error).message}。 ${pr.url}`);
  }
  const merged = await view(pr.number);
  if (merged.state !== 'MERGED') return wait(`等待 GitHub 确认合并。 ${pr.url}`);
  return finish(merged);
}
