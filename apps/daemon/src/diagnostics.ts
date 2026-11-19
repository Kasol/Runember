import { DatabaseSync } from 'node:sqlite';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { classifyDiagnosticError, redactDiagnosticText, sanitizeDiagnosticReport, runDetails, taskView, type DiagnosticFinding, type DiagnosticReport, type Run, type Task } from '@agentdesk/core';
import type { AppConfig } from './config.js';
import { runDoctor, groupDoctorChecks } from './doctor.js';
import { readRuntimeConfig } from './agent-settings.js';
import { readRunLog } from './run-log.js';
import { APP_VERSION } from './version.js';
import { networkSettings } from './network-settings.js';

function report(scope: DiagnosticReport['scope']): DiagnosticReport {
  return { schemaVersion: 1, product: 'Runember', generatedAt: new Date().toISOString(), scope,
    platform: { os: process.platform, arch: process.arch, node: process.version, version: APP_VERSION }, findings: [] };
}
function finding(code: string, level: DiagnosticFinding['level'], title: string, detail: string, suggestions: string[] = []): DiagnosticFinding {
  return { code, level, certainty: 'confirmed', title, detail, suggestions, evidence: [] };
}
async function tail(path: string): Promise<string> { return (await readRunLog(path)).text; }

/** Only recognized error fields and stderr are candidates; prompts, tool output and final answers are excluded. */
export function errorEvidence(log: string): string[] {
  const lines: string[] = [];
  for (const raw of log.split(/\r?\n/)) {
    if (raw.startsWith('[stderr]')) { lines.push(raw.slice(8).trim()); continue; }
    try {
      const event = JSON.parse(raw);
      const kind = event.type ?? event.event?.type;
      if (kind === 'turn.failed' || kind === 'error' || (kind === 'item.completed' && event.item?.type === 'error')) {
        const text = event.error?.message ?? event.payload?.message ?? event.message ?? event.item?.message ?? event.item?.text;
        if (typeof text === 'string') lines.push(text);
      }
    } catch { /* A bounded log tail can start in the middle of a JSON line. */ }
  }
  return lines;
}

export async function diagnoseTask(task: Task, run?: Run): Promise<DiagnosticReport> {
  const result = report('task'); result.taskId = task.id; result.runId = run?.id;
  if (!run) { result.findings.push(finding('not_started', 'info', '任务尚未执行', '本任务还没有 Run 记录。', ['启动草稿，或查看排队任务前面的执行情况。'])); return result; }
  const details = runDetails(run, task.agent_id ?? 'codex');
  const state = taskView(task, run);
  if (state.state === 'awaiting_confirmation') {
    result.findings.push(finding('awaiting_input', 'info', 'Agent 正在等待用户输入', '本轮已经停下，任务详情中保留了需要回答的问题。', ['查看任务详情中的确认问题，通过「继续」提供反馈。'])); return result;
  }
  if (state.state === 'cancelled') {
    result.findings.push(finding('cancelled', 'info', '执行器已确认取消', '取消前产生的文件和外部操作按实际结果保留。', ['如需处理已有改动，先查看本轮日志和工作区变更。'])); return result;
  }
  if (state.state === 'running' && run.connection?.state === 'retrying') {
    result.findings.push(finding('connection_retrying', 'warning', 'Agent 最近处于连接重试中',
      `${run.connection.reason}；开始重连：${run.connection.since}；最后有效活动：${run.connection.lastProgressAt}。`,
      ['执行器仍未结算，请在环境设置检查代理和连接；可主动取消。']));
    return result;
  }
  const errors: Array<{ source: string; text: string }> = [];
  if (details.diagnostic) errors.push({ source: `Run #${run.id} 运行说明`, text: details.diagnostic });
  if (run.log_path) {
    try { errors.push(...errorEvidence(await tail(run.log_path)).map(text => ({ source: `Run #${run.id} 日志`, text }))); }
    catch { result.findings.push(finding('log_unavailable', 'warning', '运行日志不可读取', '本轮记录的日志文件已移动、删除或无法访问。', ['检查原日志目录；修改日志设置不会自动迁移历史日志。'])); }
  }
  const failed = run.exit_code !== undefined && run.exit_code !== null && run.exit_code !== 0 || ['failed', 'blocked', 'interrupted'].includes(run.status);
  // A primary executor diagnostic outranks shutdown telemetry and optional MCP warnings.
  const primary = errors.length && details.diagnostic ? classifyDiagnosticError(details.diagnostic, errors[0]!.source) : undefined;
  if (failed && primary) result.findings.push(primary);
  if (failed && !primary) for (const error of errors) {
    const match = classifyDiagnosticError(error.text, error.source);
    if (match && !result.findings.some(item => item.code === match.code)) result.findings.push(match);
  }
  if (run.execution?.timedOut || run.blocked_kind === 'timeout') result.findings.push(finding('timeout', 'error', '执行超时', '本轮因执行时限停止，原因不等同于业务任务失败。', ['查看最后活动和错误证据，确认模型连接或工具是否一直等待。', '确认任务需要更长时间后再调整超时设置或续跑。']));
  if (run.blocked_kind === 'interrupted') result.findings.push(finding('interrupted', 'warning', '本轮执行发生中断', '现有记录未确认这一轮的完整执行结果。', ['核对工作区和最后日志，再决定是否恢复原会话。']));
  if (!result.findings.some(item => item.level === 'error')) {
    if (failed) {
      const item = finding('executor_failed', 'error', '执行器异常停止', `本轮退出码为 ${run.exit_code ?? '未知'}，已有证据不足以确定具体原因。`, ['查看最后运行日志；在对应 Agent 客户端验证登录和模型连接。', '保留现场，导出诊断结果后再决定续跑或重试。']);
      item.certainty = 'possible';
      item.evidence = errors.slice(-2).map(error => ({ source: error.source, text: redactDiagnosticText(error.text).slice(0, 1000) })); result.findings.push(item);
    } else if (state.state === 'running') result.findings.push(finding('running', 'info', taskView(task, run).stopping ? '执行器正在停止' : '任务仍在运行', '当前没有足够证据认定运行异常；可通过最近活动查看进度。', ['查看最近活动；如果决定取消，等待执行器确认退出。']));
    else result.findings.push(finding('normal_exit', 'info', '执行器正常退出', '运行事件未显示异常。任务业务目标是否达成，请结合 Agent 答复和实际产物判断。'));
  }
  return result;
}

/** CLI uses a read-only database connection and works without a running daemon. */
export async function diagnoseStoredTask(cfg: AppConfig, taskId: number, runId?: number): Promise<DiagnosticReport> {
  const file = join(cfg.dataDir, 'agentdesk.db');
  if (!existsSync(file)) throw new Error('当前数据目录没有任务数据库。');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId) as unknown as Task | undefined;
    if (!task) throw new Error('任务不存在。');
    const raw = (runId === undefined ? db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY id DESC LIMIT 1').get(taskId)
      : db.prepare('SELECT * FROM runs WHERE id=? AND task_id=?').get(runId, taskId)) as (Run & { execution_json?: string; connection_json?: string; network_json?: string }) | undefined;
    if (runId !== undefined && !raw) throw new Error('该 Run 不属于当前任务。');
    const run = raw ? { ...raw, execution: raw.execution_json ? JSON.parse(raw.execution_json) : undefined,
      connection: raw.connection_json ? JSON.parse(raw.connection_json) : undefined,
      network: raw.network_json ? JSON.parse(raw.network_json) : undefined } : undefined;
    return await diagnoseTask(task, run);
  } finally { db.close(); }
}

export async function diagnoseEnvironment(cfg: AppConfig, agentId?: string, options: Parameters<typeof runDoctor>[1] = {}): Promise<DiagnosticReport> {
  const result = report('environment');
  for (const row of groupDoctorChecks(await runDoctor(readRuntimeConfig(cfg), { ...options, agentId }))) {
    const item = finding(`environment:${row.name}`, row.ok ? 'info' : row.required ? 'error' : 'warning', row.name, redactDiagnosticText(row.detail));
    item.check = { ok: row.ok, path: row.path, version: row.version, status: row.status };
    result.findings.push(item);
  }
  const network = networkSettings(readRuntimeConfig(cfg), { getSetting: () => undefined });
  result.findings.push(finding('agent_proxy', 'info', 'Agent 宿主代理', network.httpsProxy || '未指定代理，沿用进程环境。'));
  const origin = `http://${cfg.server.host === '::1' ? '[::1]' : '127.0.0.1'}:${cfg.server.port}`;
  let lock: { instanceId?: string } | undefined;
  try { lock = JSON.parse(readFileSync(join(cfg.dataDir, 'daemon.lock'), 'utf8')); } catch {}
  try {
    const response = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(2000) });
    const health = response.ok ? await response.json() as { instanceId?: string } : undefined;
    if (health?.instanceId && health.instanceId === lock?.instanceId) result.findings.push(finding('daemon_online', 'info', '后台服务在线', '端口和当前数据目录的实例标识一致。'));
    else result.findings.push(finding('port_conflict', 'error', '端口与当前运行实例不匹配', '端口上存在其他服务，或客户端连接的数据目录不一致。', ['检查「关于」中的运行时路径和当前数据目录，确认启动的是同一套配置。', '不要直接结束陌生进程；确认归属后停止旧实例或更改端口。']));
  } catch {
    result.findings.push(finding('daemon_offline', 'warning', '后台服务不可连接', '当前端口未响应，诊断仍可从本机读取启动记录。', ['启动后台服务；若启动失败，查看下方最近启动错误。']));
    try {
      const lines = (await tail(join(cfg.logDir, 'daemon.log'))).split(/\r?\n/).filter(line => /error|failed|失败|EADDRINUSE|EACCES|EPERM/i.test(line));
      for (const line of lines.slice(-4)) {
        const item = classifyDiagnosticError(line, 'daemon 最近日志');
        if (item && !result.findings.some(found => found.code === item.code)) result.findings.push(item);
      }
    } catch { /* A first installation may not have a daemon log yet. */ }
  }
  let directory = resolve(cfg.logDir);
  while (!existsSync(directory) && dirname(directory) !== directory) directory = dirname(directory);
  try { accessSync(directory, constants.W_OK); result.findings.push(finding('log_directory', 'info', '日志目录', cfg.logDir)); }
  catch { result.findings.push(finding('log_permission', 'error', '日志目录不可写', cfg.logDir, ['在环境设置中选择当前运行账号可写的文件夹。'])); }
  return result;
}

export function diagnosticExport(value: DiagnosticReport): string {
  return JSON.stringify(sanitizeDiagnosticReport(value, homedir()), null, 2) + '\n';
}
