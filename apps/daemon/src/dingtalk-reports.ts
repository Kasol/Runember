import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describeActivity, runDetails, taskRunStateLabel, taskView, type NotifyEvent, type Run, type UiLanguage } from '@agentdesk/core';
import type { DingTalkReportConfig } from './config.js';
import { runDetailsMarkdown } from './dingtalk-markdown.js';
import type { Store } from './store.js';

export type ReportLink = (event: NotifyEvent, language?: UiLanguage, options?: { deadlineAt?: number }) => Promise<string | undefined>;

interface DocumentReceipt {
  state: 'creating' | 'writing' | 'verifying' | 'ready';
  nodeId?: string;
  url?: string;
  contentHash?: string;
}

interface DwsResult {
  success?: boolean;
  nodeId?: string;
  markdown?: string;
  docUrl?: string;
  serverResponse?: { nodeId?: string; docUrl?: string };
  degradations?: unknown[];
  jsonml?: unknown;
  revision?: number;
}

const invoke = promisify(execFile);

export class ReportError extends Error {
  constructor(message: string, public retryable = true) { super(message); }
}

function fenced(text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/^`+/gm), match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

/** Bound each code block before the document service applies its lossy long-block split. */
export function reportLogChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 6000, text.length);
    // Never split a UTF-16 surrogate pair or CRLF across blocks.
    if (end < text.length && (/[\uD800-\uDBFF]/.test(text[end - 1]!) || text[end - 1] === '\r')) end--;
    chunks.push(text.slice(start, end)); start = end;
  }
  return chunks;
}

export function documentLogBlocks(jsonml: unknown, language: UiLanguage): Array<[string, Record<string, unknown>, ...unknown[]]> {
  const nodes: unknown[][] = [];
  const walk = (node: unknown) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'string') nodes.push(node);
    for (const child of node) if (Array.isArray(child)) walk(child);
  };
  walk(jsonml);
  const text = (node: unknown): string => typeof node === 'string' ? node : Array.isArray(node)
    ? node.slice(2).map(text).join('') : '';
  const heading = language === 'en' ? 'Full Run log' : '完整 Run 日志';
  let start = -1;
  nodes.forEach((node, index) => { if (node[0] === 'h2' && text(node) === heading) start = index; });
  if (start < 0) return [];
  return nodes.slice(start + 1).filter(node => node[0] === 'code' && node[1] && typeof node[1] === 'object')
    .map(node => node as [string, Record<string, unknown>, ...unknown[]]);
}

function docUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && url.hostname === 'alidocs.dingtalk.com') return url.href;
  } catch { /* Ignore an invalid provider link. */ }
}

/** Report creation is optional and belongs to the notification channel. */
export class DingTalkReports {
  private pending = new Map<number, Promise<string | undefined>>();
  private tail: Promise<unknown> = Promise.resolve();
  private directory: string;

  constructor(
    private cfg: DingTalkReportConfig,
    private store: Store,
    logDir: string,
    private options: { retryDelaysMs?: number[] } = {},
  ) {
    const key = createHash('sha256')
      .update(JSON.stringify([resolve(cfg.configDir), cfg.profile ?? '', cfg.folder ?? ''])).digest('hex').slice(0, 16);
    this.directory = resolve(logDir, 'reports', `dingtalk-${key}`);
  }

  publish: ReportLink = (event, language = 'zh-CN', options) => {
    if (event.kind === 'run.started' || event.kind.startsWith('run.connection_')) return Promise.resolve(undefined);
    const existing = this.pending.get(event.runId);
    if (existing) return existing;
    const deadlineAt = options?.deadlineAt ?? Date.now() + 180_000;
    const job = this.tail.catch(() => {}).then(() => this.create(event, language, deadlineAt));
    this.tail = job;
    this.pending.set(event.runId, job);
    void job.finally(() => this.pending.delete(event.runId)).catch(() => {});
    return job;
  };

  private async call(args: string[], deadlineAt = Date.now() + 180_000): Promise<DwsResult> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new ReportError('报告等待已达上限，将在后台重试。');
    const operation = invoke(this.cfg.executable, [
      ...(this.cfg.profile ? ['--profile', this.cfg.profile] : []), ...args, '--format', 'json',
    ], {
      windowsHide: true, timeout: Math.min(90_000, remaining), maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, DWS_CONFIG_DIR: resolve(this.cfg.configDir),
        DWS_CACHE_DIR: join(this.directory, 'dws-cache'), DWS_NO_SKILLS: '1' },
    });
    operation.child.stdin?.end();
    let stdout: string;
    try { stdout = (await operation).stdout; }
    catch (error) {
      const failure = error as { code?: string | number; stdout?: string; stderr?: string };
      let category = '';
      try { const data = JSON.parse(failure.stdout || failure.stderr || '{}'); category = [data.error?.category, data.error?.reason].filter(value => typeof value === 'string' && /^[a-z_]+$/.test(value)).join('/'); } catch {}
      throw new ReportError(`钉钉文档命令 ${args.slice(0, 2).join(' ')} 未成功执行（${failure.code ?? 'unknown'}${category ? ': ' + category : ''}）。`, !/auth|permission|forbidden|invalid_argument/.test(category));
    }
    let result: DwsResult | undefined;
    // Long writes can print progress before the final JSON object.
    for (const match of stdout.matchAll(/^\s*\{/gm)) {
      try { result = JSON.parse(stdout.slice(match.index)) as DwsResult; break; }
      catch { /* Keep looking for the final JSON result. */ }
    }
    if (!result) throw new ReportError('钉钉文档命令返回了无法解析的结果。');
    if (result.success !== true && !(args[1] === 'read' && args.includes('jsonml') && Array.isArray(result.jsonml))) throw new ReportError('钉钉未确认文档操作成功。');
    return result;
  }

  private async retry<T>(operation: () => Promise<T>, deadlineAt: number): Promise<T> {
    const delays = this.options.retryDelaysMs ?? [2000, 5000, 10000];
    for (let attempt = 0; ; attempt++) {
      if (Date.now() >= deadlineAt) throw new ReportError('报告等待已达上限，将在后台重试。');
      try { return await operation(); }
      catch (error) {
        if (!(error instanceof ReportError) || !error.retryable || attempt >= delays.length || Date.now() + delays[attempt]! >= deadlineAt) throw error;
        await new Promise(resolve => setTimeout(resolve, delays[attempt]));
      }
    }
  }

  private render(event: NotifyEvent, run: Run, language: UiLanguage): { markdown: string; checks: string[]; logChunks: string[] } {
    const t = (zh: string, en: string) => language === 'en' ? en : zh;
    const details = runDetails(run, event.project.agent_id, event.task.partial_remaining);
    const state = taskView(event.task, run);
    const logs = run.log_path ? readFileSync(run.log_path, 'utf8') : t('这轮没有可用的 Run 日志。', 'No log is available for this run.');
    const logChunks = reportLogChunks(logs.replace(/\r\n/g, '\n'));
    const clock = (value: string) => new Date(value).toLocaleString(language, { timeZone: 'Asia/Shanghai', hour12: false });
    const activities = this.store.recentRunActivities(run.id);
    const fileChanges = details.filesChanged ?? [];
    const sections = [
      `# ${t('任务', 'Task')} #${event.task.id} · Run #${run.id} · ${event.project.name}`,
      taskRunStateLabel(state, details, language),
      `## ${t('运行详情', 'Run details')}`,
      run.started_at ? `${t('开始时间', 'Started')} · ${clock(run.started_at)}` : '',
      run.ended_at ? `${t('结算时间', 'Ended')} · ${clock(run.ended_at)}` : '',
      runDetailsMarkdown(details, state.state === 'awaiting_confirmation', language),
      `## ${t('任务指令', 'Task prompt')}`,
      event.task.prompt,
      `## ${t('最近活动', 'Recent activity')}`,
      activities.length ? activities.map(item => `- ${clock(item.at)} · ${describeActivity(item, language)}`).join('\n')
        : t('本轮没有记录活动摘要。', 'No activity was recorded for this run.'),
      `## ${t('文件变更', 'File changes')}`,
      fileChanges.length ? fileChanges.map(file => `- ${file}`).join('\n') : t('本轮未记录到文件变更。', 'No file changes were recorded for this run.'),
      details.diffStat ? fenced(details.diffStat) : '',
      `## ${t('完整 Run 日志', 'Full Run log')}`,
      ...logChunks.map((chunk, index) => `### ${t('日志片段', 'Log segment')} ${index + 1}/${logChunks.length}\n\n${fenced(chunk)}`),
    ];
    const checks = [t('运行详情', 'Run details'), t('任务指令', 'Task prompt'), t('最近活动', 'Recent activity'), t('文件变更', 'File changes'), t('完整 Run 日志', 'Full Run log'),
      ...[event.task.prompt, details.summary ?? ''].flatMap(text => text.split(/\r?\n/).filter(Boolean))];
    return { markdown: sections.filter(Boolean).join('\n\n') + '\n', checks, logChunks };
  }

  private async create(event: NotifyEvent, language: UiLanguage, deadlineAt: number): Promise<string> {
    const directory = join(this.directory, `run-${event.runId}`);
    const receiptPath = join(directory, 'document.json');
    mkdirSync(directory, { recursive: true });
    let receipt: DocumentReceipt | undefined = existsSync(receiptPath)
      ? JSON.parse(readFileSync(receiptPath, 'utf8')) as DocumentReceipt : undefined;
    if (receipt?.state === 'ready') {
      const url = docUrl(receipt.url);
      if (!url) throw new Error('已保存的报告链接无效。');
      return url;
    }
    if (Date.now() >= deadlineAt) throw new ReportError('报告排队等待已达上限，将在后台重试。');
    if (receipt?.state === 'creating') {
      throw new Error('报告上次创建结果尚未核实，请检查报告目录里的创建记录。');
    }
    const run = this.store.getRun(event.runId);
    if (!run || run.task_id !== event.task.id || ['starting', 'running', 'queued'].includes(run.status)) {
      throw new Error('这轮运行尚未结束，无法发布最终报告。');
    }
    const { markdown, checks, logChunks } = this.render(event, run, language);
    const reportFile = join(directory, 'report.md');
    writeFileSync(reportFile, markdown, { mode: 0o600 });
    const save = (value: DocumentReceipt) => {
      writeFileSync(receiptPath + '.tmp', JSON.stringify(value), { mode: 0o600 });
      renameSync(receiptPath + '.tmp', receiptPath);
      receipt = value;
    };
    if (!receipt?.nodeId) {
      // Persist intent first. An ambiguous create must not generate duplicate documents.
      save({ state: 'creating' });
      const created = await this.call(['doc', 'create', '--name',
        `Runember · ${event.project.name} · ${language === 'en' ? 'Task' : '任务'} ${event.task.id} · Run ${run.id}`,
        ...(this.cfg.folder ? ['--folder', this.cfg.folder] : [])], deadlineAt);
      const nodeId = created.nodeId ?? created.serverResponse?.nodeId;
      const url = docUrl(created.docUrl ?? created.serverResponse?.docUrl);
      if (!nodeId || !url) throw new Error('钉钉创建报告后未返回有效的节点和链接。');
      save({ state: 'writing', nodeId, url });
    }
    const nodeId = receipt!.nodeId!;
    const url = receipt!.url!;
    if (!docUrl(url)) throw new Error('已保存的报告链接无效。');
    const contentHash = createHash('sha256').update(markdown).digest('hex');
    // Overwrite is limited to the report node created and persisted above.
    if (receipt?.state !== 'verifying' || receipt.contentHash !== contentHash) {
      const updated = await this.retry(() => this.call(['doc', 'update', '--node', nodeId, '--content-file', reportFile,
        '--mode', 'overwrite', '--yes'], deadlineAt), deadlineAt);
      if (updated.degradations?.length) console.warn(`[dingtalk-report] Run #${run.id} 报告长内容已分块排版。`);
      save({ state: 'verifying', nodeId, url, contentHash });
    }
    await this.retry(async () => {
      const readback = await this.call(['doc', 'read', '--node', nodeId], deadlineAt);
      const normalized = readback.markdown?.replace(/\r\n/g, '\n');
      if (typeof normalized !== 'string' || !checks.every(line => normalized.includes(line))) throw new ReportError('钉钉报告回读未通过完整性检查，保留本地报告供重试。');
    }, deadlineAt);
    // Markdown import/export may insert whitespace even inside code. Native code attributes
    // preserve the exact log bytes; repair only this generated document under a revision guard.
    const readNative = () => this.retry(async () => {
      const value = await this.call(['doc', 'read', '--node', nodeId, '--content-format', 'jsonml'], deadlineAt);
      if (documentLogBlocks(value.jsonml, language).length !== logChunks.length) throw new ReportError('钉钉报告日志分段数量不一致，保留本地报告供重试。');
      return value;
    }, deadlineAt);
    let native = await readNative();
    let blocks = documentLogBlocks(native.jsonml, language);
    if (blocks.length !== logChunks.length) throw new ReportError('钉钉报告日志分段数量不一致，保留本地报告供重试。');
    if (blocks.some((block, index) => block[1].code !== logChunks[index])) {
      blocks.forEach((block, index) => {
        block[1].code = logChunks[index];
        block.splice(2, block.length - 2, ['span', { 'data-type': 'text' }, ['span', { 'data-type': 'leaf' }, logChunks[index]]]);
      });
      const nativeFile = join(directory, 'report.json');
      writeFileSync(nativeFile, JSON.stringify(native.jsonml), { mode: 0o600 });
      if (!Number.isSafeInteger(native.revision)) throw new Error('钉钉报告缺少版本号，无法安全修复日志格式。');
      await this.call(['doc', 'update', '--node', nodeId, '--content-format', 'jsonml', '--content-file', nativeFile,
        '--revision', String(native.revision), '--mode', 'overwrite', '--yes'], deadlineAt);
      native = await readNative();
      blocks = documentLogBlocks(native.jsonml, language);
    }
    if (blocks.length !== logChunks.length || blocks.some((block, index) => block[1].code !== logChunks[index])) {
      throw new Error('钉钉报告原始日志校验失败，保留本地报告供重试。');
    }
    save({ state: 'ready', nodeId, url });
    console.log(`[dingtalk-report] 报告已核对 task=${event.task.id} run=${run.id}`);
    return url;
  }
}
