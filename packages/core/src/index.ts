/**
 * @agentdesk/core —— 纯领域层：类型 + 状态机 + 分类规则 + 三大扩展接口。
 *
 * 铁律：本包零 IO（不碰 Docker/网络/文件系统/时钟），全部是可单测的纯逻辑。
 * daemon 只是它的"驱动层"；未来桌面壳、换执行后端、加 Agent、加通知渠道，
 * 这一层不动。
 */

// ─────────────────────────── 领域类型 ───────────────────────────
import { reasoningLabel } from './reasoning.js';

export type AgentId = string;
export function agentLabel(id?: string | null): string {
  return ({ codex: 'Codex', zcode: 'ZCode', deepseek: 'DeepSeek Harness' } as Record<string, string>)[id ?? 'codex'] ?? id!;
}

export type TaskStatus =
  | 'draft'       // 草稿：Web 派发后可编辑/排序，点「执行」才入队
  | 'queued'      // 已入队等待调度
  | 'running'     // 有 Run 正在执行
  | 'blocked'     // 等人（审批/凭证/额度/超时）
  | 'done'        // 成功完成
  | 'failed'      // 失败
  | 'cancelled';  // 人工取消

export type RunStatus =
  | 'queued' | 'starting' | 'running'
  | 'succeeded' | 'failed' | 'blocked' | 'cancelled';

/** blocked 的原因分类 —— 通知文案与恢复策略都挂在它上面 */
export type BlockedKind =
  | 'approval_needed'    // agent 主动声明需要人决策（协议标记）
  | 'auth_missing'       // 凭证缺失/失效（401 / 未登录 / auth.json 不存在）
  | 'quota_exhausted'    // 额度耗尽（429 / usage limit —— Plus 订阅的周窗口）
  | 'external_write'     // 任务期间检测到外部修改（host-dir 模式的竞态防护，预留）
  | 'timeout'            // 超时被看门狗击杀
  | 'interrupted'        // daemon 中断，无法确认已完成
  | 'git_in_progress'    // 当前工作树有尚未结束的 Git 操作
  | 'verification_failed' // 答复明确报告验收失败，流程暂停
  | 'missing_result'     // CLI 正常退出，但没有返回任务答复
  | 'unknown_error';

/**
 * 执行模式：
 *  - capability（默认）：能力优先。codex 直接跑宿主（原生速度、Windows 原生依赖可用、
 *    skills/auth 原生）。定位：离线调度机——无人操作、无竞态前提，共享宿主状态安全。
 *  - isolation：隔离优先。Linux 容器执行（强隔离、环境钉版本）。
 *    注册时检测项目内 Linux 不支持的组件（Windows 原生二进制等），有则拒绝并提示切换 capability。
 */
export type ExecutionMode = 'capability' | 'isolation';

export * from './reasoning.js';

export interface Project {
  id: number;
  name: string;
  /** 项目绝对路径 */
  workspace_path: string;
  agent_id: AgentId;
  /** 项目默认模型；空值沿用执行器配置。 */
  model?: string | null;
  reasoning_effort?: string | null;
  /** 执行模式，默认 capability */
  execution?: ExecutionMode;
  /** 隔离模式专用：项目级系统依赖（预装进项目专属镜像） */
  extraPackages?: string[];
  /** 隔离模式专用：项目声明的 MCP server 名（渲染进容器 config.toml） */
  mcpServers?: string[];
  created_at: string;
}

/**
 * 宿主工具清单：清单内的工具【始终走宿主】且必须存在（注册/运行前强制检查）。
 * 内置默认 git；config.hostTools 可扩展。
 */
export interface HostTool {
  /** which/检测命令参数（如 --version） */
  checkArgs?: string[];
  required?: boolean;
}

export interface Task {
  id: number;
  project_id: number;
  /** 创建时保存的执行配置，续跑使用同一执行器。旧记录按 Codex 兼容。 */
  agent_id?: AgentId | null;
  model?: string | null;
  reasoning_effort?: string | null;
  execution?: ExecutionMode | null;
  prompt: string;
  status: TaskStatus;
  /** resume 时携带的人工反馈；runner 据此决定是新会话还是续会话 */
  pending_feedback?: string;
  /** 部分完成时 agent 自报的未完成清单（非空 = partial；供人决定是否派后续任务） */
  partial_remaining?: string | null;
  created_at: string;
}

export interface Run {
  id: number;
  task_id: number;
  agent_id?: AgentId | null;
  model?: string | null;
  reasoning_effort?: string | null;
  kind: 'normal' | 'resume';
  /** adapter 会话 id（codex thread id），续跑的钥匙 */
  session_id?: string;
  checkpoint_sha?: string;
  worker?: { kind: 'native'; pid: number; control?: string } | { kind: 'docker'; id: string };
  cancellation?: { requestedAt: string; issue?: string; killSent?: boolean };
  execution?: { stoppedAt: string; exitCode: number | null; cancelled?: boolean; timedOut?: boolean; error?: string };
  status: RunStatus;
  exit_code?: number;
  blocked_kind?: BlockedKind;
  log_path?: string;
  summary_json?: string;
  started_at?: string;
  ended_at?: string;
}

export interface RunSummary {
  agentMessage?: string;
  filesChanged: string[];
  diffStat: string;
  sessionId?: string;
  usageNote?: string;
  /** 旧协议保留的 Agent 自报交付信息。 */
  partial?: boolean;
  remaining?: string;
  inputRequest?: string;
  blocker?: string;
  diagnostic?: string;
  artifacts?: RunArtifact[];
  agentId?: AgentId;
  model?: string;
}

export type TaskState = 'draft' | 'queued' | 'running' | 'awaiting_confirmation' | 'ended' | 'cancelled';
export type UiLanguage = 'zh-CN' | 'en';
export type LanguagePreference = 'auto' | UiLanguage;

export const TASK_STATE_LABELS: Record<TaskState, string> = {
  draft: '📝 草稿', queued: '⏳ 排队', running: '▶️ 运行中',
  awaiting_confirmation: '🟡 等待确认', ended: '⏹ 已结束', cancelled: '🚫 已取消',
};

export interface TaskView extends Task {
  state: TaskState;
  confirmation?: string;
  stopping?: boolean;
}

export function taskStateLabel(task: Pick<TaskView, 'state' | 'stopping'>, language: UiLanguage = 'zh-CN'): string {
  if (language === 'en') {
    const labels: Record<TaskState, string> = {
      draft: '📝 Draft', queued: '⏳ Queued', running: '▶️ Running',
      awaiting_confirmation: '🟡 Awaiting confirmation', ended: '⏹ Ended', cancelled: '🚫 Cancelled',
    };
    return task.state === 'running' && task.stopping ? `${labels.running} · Stopping` : labels[task.state];
  }
  return task.state === 'running' && task.stopping
    ? `${TASK_STATE_LABELS.running} · 正在停止` : TASK_STATE_LABELS[task.state];
}

export interface TaskActions {
  resume: 'session' | 'new_session' | false;
  retry: boolean;
  cancel: boolean;
}

export interface RunArtifact {
  label: string;
  location: string;
  href?: string;
}

export interface RunDetails {
  id: number;
  agentId?: AgentId;
  model?: string;
  reasoningEffort?: string | null;
  elapsedMs?: number;
  stage: string;
  exitCode?: number;
  summary?: string;
  diagnostic?: string;
  confirmation?: string;
  blocker?: string;
  remaining?: string;
  artifacts: RunArtifact[];
  cancellationRequestedAt?: string;
  stoppedAt?: string;
  stopIssue?: string;
  filesChanged?: string[];
  diffStat?: string;
}

/** 兼容旧会话的结构化报告。 */
export const AGENTCTL_MARKER = '###AGENTCTL_BLOCKED###';
export const AGENTCTL_RESULT_MARKER = '###AGENTCTL_RESULT###';

const nonBlank = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

function answerLines(text: string): Array<{ line: string; outsideCode: boolean }> {
  let fence: string | undefined;
  return text.split('\n').map(line => {
    const trimmed = line.trim();
    const delimiter = /^(`{3,}|~{3,})/.exec(trimmed)?.[0];
    if (!delimiter) return { line, outsideCode: !fence && !trimmed.startsWith('>') };
    if (!fence) fence = delimiter;
    else if (delimiter[0] === fence[0] && delimiter.length >= fence.length && trimmed === delimiter) fence = undefined;
    return { line, outsideCode: false };
  });
}

function legacyReport(text: string, marker: string): Record<string, unknown> | undefined {
  for (const { line, outsideCode } of answerLines(text).reverse()) {
    const trimmed = line.trim();
    if (!outsideCode || !trimmed.startsWith(marker)) continue;
    try {
      const value = JSON.parse(trimmed.slice(marker.length));
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* 跳过无效旧协议行 */ }
  }
}

export function parseResultMarker(text: string): {
  done: boolean; summary?: string; remaining?: string; blocker?: string; artifacts?: unknown[];
} | null {
  const report = legacyReport(text, AGENTCTL_RESULT_MARKER);
  if (typeof report?.done !== 'boolean') return null;
  return {
    done: report.done, summary: nonBlank(report.summary), remaining: nonBlank(report.remaining),
    blocker: nonBlank(report.blocker), artifacts: Array.isArray(report.artifacts) ? report.artifacts : undefined,
  };
}

export function parseInputRequest(text: string): string | undefined {
  const report = legacyReport(text, AGENTCTL_MARKER);
  return nonBlank(report?.question) ?? nonBlank(report?.reason);
}

export function stripAgentctlLines(text: string): string {
  return answerLines(text)
    .filter(({ line, outsideCode }) => !outsideCode || ![AGENTCTL_MARKER, AGENTCTL_RESULT_MARKER]
      .some(marker => line.trimStart().startsWith(marker)))
    .map(({ line }) => line)
    .join('\n');
}

export function readRunSummary(run?: Run): RunSummary | undefined {
  if (!run?.summary_json) return;
  try {
    const value = JSON.parse(run.summary_json);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as RunSummary;
  } catch { /* 旧记录可能没有可读摘要 */ }
}

function runInputRequest(run: Run | undefined, summary: RunSummary | undefined): string | undefined {
  if (run?.status !== 'blocked' || run.blocked_kind !== 'approval_needed') return;
  return nonBlank(summary?.inputRequest) ?? parseInputRequest(nonBlank(summary?.agentMessage) ?? '');
}

export function taskView(task: Task, run?: Run): TaskView {
  const status = task.status;
  if (status === 'running') return { ...task, state: status, stopping: !!run?.cancellation };
  if (status !== 'blocked' && status !== 'failed' && status !== 'done') return { ...task, state: status };
  const confirmation = status === 'blocked' ? runInputRequest(run, readRunSummary(run)) : undefined;
  return { ...task, state: confirmation ? 'awaiting_confirmation' : 'ended', confirmation };
}

export function runStage(run: Run): string {
  if ((run.status === 'starting' || run.status === 'running') && run.cancellation) return '正在停止';
  if (run.status === 'starting') return '准备执行';
  if (run.status === 'running') return '运行中';
  if (run.status === 'queued') return '排队';
  if (run.status === 'cancelled') return '已取消';
  switch (run.blocked_kind) {
    case 'timeout': return '运行超时';
    case 'interrupted': return '运行中断';
    case 'auth_missing': return '认证未通过';
    case 'quota_exhausted': return '执行器请求受限';
  }
  if (run.exit_code === 0) return '正常退出';
  if (run.exit_code != null && run.exit_code !== -1) return '异常退出';
  if (!run.worker && run.status === 'blocked' && !runInputRequest(run, readRunSummary(run))) return '启动检查未通过';
  if (!run.worker && run.status === 'failed') return '启动失败';
  if (run.status === 'failed') return '执行异常';
  return '已停止';
}

export function runDetails(run: Run, agentId?: AgentId, remaining?: string | null): RunDetails {
  const summary = readRunSummary(run);
  const answer = nonBlank(summary?.agentMessage) ?? '';
  const report = parseResultMarker(answer);
  const text = nonBlank(stripAgentctlLines(answer)) ?? report?.summary;
  const started = Date.parse(run.started_at ?? '');
  const ended = Date.parse(run.ended_at ?? '');
  const artifacts = new Map<string, RunArtifact>();
  const addArtifact = (label: unknown, location: unknown) => {
    const name = nonBlank(label);
    const target = nonBlank(location);
    if (!name || !target) return;
    if (/^https?:\/\/[^\s<>]+$/i.test(target)) artifacts.set(target, { label: name, location: target, href: target });
    else if (/^(?:\/(?!\/)|[A-Za-z]:[\\/])/.test(target)) artifacts.set(target, { label: name, location: target });
  };
  if (Array.isArray(summary?.artifacts)) {
    for (const artifact of summary.artifacts) addArtifact(artifact?.label, artifact?.location);
  }
  for (const artifact of report?.artifacts ?? []) {
    if (typeof artifact === 'object' && artifact !== null && 'label' in artifact && 'location' in artifact) {
      addArtifact(artifact.label, artifact.location);
    }
  }
  for (const { line, outsideCode } of answerLines(text ?? '')) {
    if (!outsideCode) continue;
    for (const link of line.matchAll(/!?\[([^\]\r\n]+)\]\(([^)\r\n]+)\)/g)) {
      if (!link[0].startsWith('!')) addArtifact(link[1], link[2]);
    }
  }
  const blocker = nonBlank(summary?.blocker) ?? report?.blocker ?? ({
    git_in_progress: '工作目录还有未结束的 Git 操作。',
    external_write: '运行期间检测到工作区被外部修改。',
    verification_failed: '本轮记录的验收未通过。',
  } as Partial<Record<BlockedKind, string>>)[run.blocked_kind ?? 'unknown_error'];
  return {
    id: run.id, agentId: run.agent_id ?? nonBlank(summary?.agentId) ?? agentId, model: nonBlank(summary?.model) ?? run.model ?? undefined,
    reasoningEffort: run.reasoning_effort ?? null, stage: runStage(run),
    exitCode: run.exit_code === -1 ? undefined : run.exit_code ?? undefined,
    elapsedMs: Number.isFinite(ended - started) ? Math.max(0, ended - started) : undefined,
    summary: text, diagnostic: nonBlank(summary?.diagnostic), confirmation: runInputRequest(run, summary), blocker,
    remaining: nonBlank(summary?.remaining) ?? report?.remaining
      ?? (remaining === '（agent 未给出明细）' ? undefined : nonBlank(remaining)),
    artifacts: [...artifacts.values()],
    cancellationRequestedAt: run.cancellation?.requestedAt,
    stoppedAt: run.execution?.stoppedAt ?? (run.status === 'cancelled' ? run.ended_at ?? undefined : undefined),
    stopIssue: run.status === 'starting' || run.status === 'running' ? run.cancellation?.issue : undefined,
    filesChanged: summary?.filesChanged,
    diffStat: summary?.diffStat,
  };
}

export function runTiming(details: RunDetails, language: UiLanguage = 'zh-CN'): string {
  if (language === 'en') {
    const stages: Record<string, string> = {
      '准备执行': 'Preparing', '运行中': 'Running', '排队': 'Queued', '已取消': 'Cancelled',
      '运行超时': 'Timed out', '运行中断': 'Interrupted', '认证未通过': 'Authentication failed',
      '执行器请求受限': 'Agent request limited', '正常退出': 'Normal exit', '异常退出': 'Non-zero exit',
      '启动失败': 'Startup failed', '执行异常': 'Execution error', '已停止': 'Stopped',
      '启动检查未通过': 'Startup check failed', '正在停止': 'Stopping',
    };
    const elapsed = details.elapsedMs === undefined ? '' : ` · ${(details.elapsedMs / 1000).toFixed(1)} seconds`;
    const exit = details.exitCode === undefined ? '' : ` · Exit code ${details.exitCode}`;
    return `Run #${details.id} · ${details.agentId ?? 'Agent not recorded'}${details.model ? ' / ' + details.model : ''}${details.reasoningEffort ? ' · ' + reasoningLabel(details.reasoningEffort, language) : ''} · ${stages[details.stage] ?? details.stage}${exit}${elapsed}`;
  }
  const elapsed = details.elapsedMs === undefined ? '' : ` · 耗时 ${(details.elapsedMs / 1000).toFixed(1)} 秒`;
  const exit = details.exitCode === undefined ? '' : ` · 退出码 ${details.exitCode}`;
  return `Run #${details.id} · ${details.agentId ?? 'Agent 未记录'}${details.model ? ' / ' + details.model : ''}${details.reasoningEffort ? ' · ' + reasoningLabel(details.reasoningEffort) : ''} · ${details.stage}${exit}${elapsed}`;
}

// ─────────────────────────── 状态机与分类（纯函数） ───────────────────────────

export interface ClassifyInput {
  exitCode: number | null;
  killed: boolean;
  interrupted?: boolean;
  lastAgentText: string;
  inputRequest?: string;
  errTail: string;
}

export interface ClassifyResult {
  status: 'succeeded' | 'failed' | 'blocked';
  blockedKind?: BlockedKind;
  inputRequest?: string;
}

/** Run 终态只使用执行事实与明确的输入请求。 */
export function classifyRun(input: ClassifyInput): ClassifyResult {
  if (input.killed) return { status: 'blocked', blockedKind: 'timeout' };
  if (input.interrupted) return { status: 'blocked', blockedKind: 'interrupted' };
  const inputRequest = nonBlank(input.inputRequest) ?? parseInputRequest(input.lastAgentText);
  if (inputRequest) return { status: 'blocked', blockedKind: 'approval_needed', inputRequest };
  if (input.exitCode === 0) return { status: 'succeeded' };
  const t = input.errTail.toLowerCase();
  if (/401|unauthorized|not logged in|未登录|invalid api key/.test(t)) {
    return { status: 'blocked', blockedKind: 'auth_missing' };
  }
  if (/429|usage limit|rate limit|quota|额度|exceeded your/.test(t)) {
    return { status: 'blocked', blockedKind: 'quota_exhausted' };
  }
  return { status: 'failed', blockedKind: 'unknown_error' };
}

/** 保留旧调度字段的聚合规则，用户可见状态由 taskView 映射。 */
export function taskStatusAfterRun(result: ClassifyResult): TaskStatus {
  return result.status === 'succeeded' ? 'done' : result.status;
}

// ─────────────────────────── 调度决策（纯函数） ───────────────────────────

export interface SchedulingGates {
  /** 全局并发上限（v1 默认 1 —— 由配置注入，绝不写死） */
  concurrency: number;
  /** 当前活动 Run 数 */
  activeRuns: number;
  /** 有 Run 在跑的项目集合（同项目串行的锁） */
  busyProjects: Set<number>;
}

/** 三层闸门：全局并发 → 项目锁。并行扩展 = 调大 concurrency，无需改这里 */
export function canStart(task: Task, gates: SchedulingGates): boolean {
  if (task.status !== 'queued') return false;
  if (gates.activeRuns >= gates.concurrency) return false;
  if (gates.busyProjects.has(task.project_id)) return false;
  return true;
}

// ─────────────────────────── 三大扩展接口 ───────────────────────────

/** Agent 适配器：新 Agent = 新增一个实现 + 注册，核心零改动 */
export interface AgentAdapter {
  id: AgentId;
  /** 任务执行的容器镜像（从配置读取，接口只声明能力） */
  image: string;
  /** codex-home 卷名（凭证 + 会话，resume 的命脉） */
  homeVolume: string;
  /** 可选的最终答复结构，由适配器映射为通用事件。 */
  finalResponseSchema?: object;
  /** 正常任务的命令 */
  buildArgs(prompt: string, execution?: ExecutionMode, finalResponseSchemaPath?: string, model?: string, reasoningEffort?: string): string[];
  /** 续跑命令：恢复会话并传递用户反馈 */
  buildResumeArgs(sessionId: string, feedback: string, execution?: ExecutionMode, finalResponseSchemaPath?: string, model?: string, reasoningEffort?: string): string[];
  /** 单行事件解析：返回 null 表示该行不是关心的 JSONL 事件 */
  parseLine(line: string, structuredResponse?: boolean): AdapterEvent | null;
  /** 启动前凭证自检命令（如 test -f auth.json），exit 0 为通过 */
  authCheckArgs(): string[];
}

export interface AgentActivity {
  key: string;
  kind: 'turn' | 'command' | 'files' | 'tool' | 'search' | 'message';
  phase: 'started' | 'completed' | 'failed';
  detail?: string;
}

export interface RunActivity extends AgentActivity {
  at: string;
}

export function describeActivity(item: AgentActivity, language: UiLanguage = 'zh-CN'): string {
  if (language === 'en') {
    const labels: Record<AgentActivity['kind'], Record<AgentActivity['phase'], string>> = {
      turn: { started: 'Agent started', completed: 'Agent turn ended', failed: 'Agent turn failed' },
      command: { started: 'Command started', completed: 'Command ended', failed: 'Command failed' },
      files: { started: 'Updating files', completed: 'File update ended', failed: 'File update failed' },
      tool: { started: 'Tool call started', completed: 'Tool call ended', failed: 'Tool call failed' },
      search: { started: 'Web search started', completed: 'Web search ended', failed: 'Web search failed' },
      message: { started: 'Agent update', completed: 'Agent update', failed: 'Agent update' },
    };
    return labels[item.kind][item.phase] + (item.detail ? ` · ${item.detail}` : '');
  }
  const labels: Record<AgentActivity['kind'], Record<AgentActivity['phase'], string>> = {
    turn: { started: 'Agent 开始执行', completed: 'Agent 本轮执行结束', failed: 'Agent 本轮执行失败' },
    command: { started: '开始执行命令', completed: '命令执行结束', failed: '命令执行失败' },
    files: { started: '开始更新文件', completed: '文件更新结束', failed: '文件更新失败' },
    tool: { started: '开始调用工具', completed: '工具调用结束', failed: '工具调用失败' },
    search: { started: '开始搜索网页', completed: '网页搜索结束', failed: '网页搜索失败' },
    message: { started: 'Agent 更新', completed: 'Agent 更新', failed: 'Agent 更新' },
  };
  return labels[item.kind][item.phase] + (item.detail ? ` · ${item.detail}` : '');
}

export interface AdapterEvent {
  type: 'session' | 'agent_message' | 'input_requested' | 'error' | 'activity' | 'other';
  sessionId?: string;
  model?: string;
  text?: string;
  /** 这条答复明确请求的必需输入，与该答复一起更新。 */
  inputRequest?: string;
  activity?: AgentActivity;
}

/** 通知器：daemon 只发领域事件，实现方决定发到哪（Console/钉钉/企微/邮件…） */
export type NotifyEvent = { runId: number; details?: RunDetails; actions?: TaskActions } & (
  | { kind: 'run.started'; task: Task; project: Project }
  | { kind: 'run.cancelled'; task: Task; project: Project; summary: RunSummary }
  | { kind: 'run.succeeded'; task: Task; project: Project; summary: RunSummary }
  | { kind: 'run.failed'; task: Task; project: Project; reason: string; retryViaCli?: boolean }
  | { kind: 'run.blocked'; task: Task; project: Project; blockedKind: BlockedKind; question?: string; summary?: RunSummary; retryViaCli?: boolean });

export interface Notifier {
  readonly name: string;
  notify(event: NotifyEvent): Promise<void>;
}

/** 执行后端：Docker 是 v1 唯一实现；未来 NativeBackend（免 Docker 个人机模式） */
export interface ExecutionBackend {
  readonly name: string;
}

// ─────────────────────────── 反馈通道（M3+） ───────────────────────────

/** 人从远端（IM/网页/…）发回的指令 */
export interface FeedbackAction {
  type: 'resume' | 'retry' | 'cancel' | 'status' | 'detail' | 'activity' | 'help' | 'run' | 'draft' | 'projects';
  taskId?: number;
  runId?: number;
  feedback?: string;
  /** 新任务描述，或启动草稿时给已有任务追加的说明 */
  prompt?: string;
  projectId?: number;
  projectName?: string;
  language?: UiLanguage;
}

/**
 * 反馈通道：把"人的决定"从外部世界送回 daemon。
 * 与 Notifier 对称（一个出站一个入站）；实现：钉钉 Stream / 未来 GUI/企微…
 * 通道自带回复能力（reply），dispatch 结果通过它回给人。
 */
export interface FeedbackChannel {
  readonly name: string;
  start(dispatch: (action: FeedbackAction) => Promise<{ ok: boolean; message: string }>): Promise<void>;
  stop?(): void | Promise<void>;
}
export * from './diagnostics.js';
