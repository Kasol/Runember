/**
 * @agentdesk/core —— 纯领域层：类型 + 状态机 + 分类规则 + 三大扩展接口。
 *
 * 铁律：本包零 IO（不碰 Docker/网络/文件系统/时钟），全部是可单测的纯逻辑。
 * daemon 只是它的"驱动层"；未来桌面壳、换执行后端、加 Agent、加通知渠道，
 * 这一层不动。
 */

// ─────────────────────────── 领域类型 ───────────────────────────

export type AgentId = string;

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

export interface Project {
  id: number;
  name: string;
  /** 项目绝对路径 */
  workspace_path: string;
  agent_id: AgentId;
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
  kind: 'normal' | 'resume';
  /** adapter 会话 id（codex thread id），续跑的钥匙 */
  session_id?: string;
  checkpoint_sha?: string;
  worker?: { kind: 'native'; pid: number } | { kind: 'docker'; id: string };
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
  /** 结果报告：partial = agent 自报部分完成（人类需决定后续任务） */
  partial?: boolean;
  remaining?: string;
}

/** 从 agent 末条消息解析结果标记（宽容式：无标记/坏 JSON 返回 null） */
export function parseResultMarker(text: string): { done: boolean; summary?: string; remaining?: string } | null {
  const line = text.split('\n').reverse().find(l => l.includes(AGENTCTL_RESULT_MARKER));
  if (!line) return null;
  try {
    const j = JSON.parse(line.slice(line.indexOf(AGENTCTL_RESULT_MARKER) + AGENTCTL_RESULT_MARKER.length).trim());
    return { done: j.done !== false, summary: j.summary, remaining: j.remaining };
  } catch { return null; }
}

/** 展示用：剥掉协议标记行（BLOCKED/RESULT），只留人话 */
export function stripAgentctlLines(text: string): string {
  return text
    .split('\n')
    .filter(l => !l.includes(AGENTCTL_MARKER) && !l.includes(AGENTCTL_RESULT_MARKER))
    .join('\n')
    .trim();
}

// ─────────────────────────── 阻塞协议 ───────────────────────────

/** 兼容旧会话中 agent 主动声明需要人工决策的标记 */
export const AGENTCTL_MARKER = '###AGENTCTL_BLOCKED###';
/** 兼容旧会话中 agent 的结构化结果标记 */
export const AGENTCTL_RESULT_MARKER = '###AGENTCTL_RESULT###';

// ─────────────────────────── 状态机与分类（纯函数） ───────────────────────────

export interface ClassifyInput {
  exitCode: number;
  killed: boolean;
  lastAgentText: string;   // 最后一条 agent_message（含协议标记）
  errTail: string;         // stderr/错误事件尾部
}

export interface ClassifyResult {
  status: 'succeeded' | 'failed' | 'blocked';
  blockedKind?: BlockedKind;
  reason?: string;
}

const workflow = '(?:(?:当前|本次|本轮)\\s*)?(?:自动化)?(?:合并|提交|交付|发布|部署|任务|流程)';
const failedCheck = '(?:全量|单元|集成)?(?:测试|验证|验收|检查|npm test)\\s*(?:未通过|没有通过|没过|失败|超时)';
const paused = '(?:暂停|暂缓|阻塞|无法继续|不能继续)';
const verificationBlockStatements = [
  new RegExp(`^${workflow}\\s*(?:因(?:为)?|由于)\\s*${failedCheck}\\s*(?:而|因此|所以)?\\s*${paused}(?=[。.!！]|$)`),
  new RegExp(`^(?:(?:因(?:为)?|由于)\\s*)?${failedCheck}[，,；;]\\s*(?:因此|所以)?\\s*(?:${workflow}\\s*(?:已|被|仍)?${paused}|(?:无法|不能)继续${workflow})(?=[。.!！]|$)`),
  /^(?:the\s+)?(?:merge|release|deployment|workflow|task)\s+(?:(?:is|has been)\s+)?(?:paused|blocked|stopped|on hold)\s+(?:because|due to)\s+(?:(?:the|full|automated|required)\s+)*(?:tests?|checks?|verification)\s+(?:failed|did not pass|timed out)(?=[.!]|$)/i,
];

/** 只接受答复中明确说明流程因验收失败而暂停的状态句。 */
function reportedVerificationBlock(text: string): string | undefined {
  const answer = text.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[ \t]*\r?$/gm, '');
  for (const line of answer.split('\n')) {
    const statement = line.trim().replace(/^(?:#{1,6}|[-*+] |\d+\.)\s*/, '').replace(/[*`]/g, '').trim();
    for (const pattern of verificationBlockStatements) {
      const match = statement.match(pattern);
      if (match) return match[0];
    }
  }
}

/** Run 终态由超时、人工阻塞、退出码和答复决定。 */
export function classifyRun(input: ClassifyInput): ClassifyResult {
  if (input.killed) return { status: 'blocked', blockedKind: 'timeout' };
  if (input.lastAgentText.includes(AGENTCTL_MARKER)) {
    return { status: 'blocked', blockedKind: 'approval_needed' };
  }
  if (input.exitCode === 0) {
    if (!input.lastAgentText.trim()) return { status: 'blocked', blockedKind: 'missing_result' };
    const reason = reportedVerificationBlock(input.lastAgentText);
    if (reason) return { status: 'blocked', blockedKind: 'verification_failed', reason };
    return { status: 'succeeded' };
  }
  const t = (input.errTail + '\n' + input.lastAgentText).toLowerCase();
  if (/401|unauthorized|not logged in|未登录|invalid api key/.test(t)) {
    return { status: 'blocked', blockedKind: 'auth_missing' };
  }
  if (/429|usage limit|rate limit|quota|额度|exceeded your/.test(t)) {
    return { status: 'blocked', blockedKind: 'quota_exhausted' };
  }
  return { status: 'failed', blockedKind: 'unknown_error' };
}

/** Task 聚合状态随 Run 终态迁移 */
export function taskStatusAfterRun(
  task: Task,
  run: Run,
  result: ClassifyResult,
): TaskStatus {
  switch (result.status) {
    case 'succeeded': return 'done';
    case 'blocked': return 'blocked';
    case 'failed': return 'failed';
  }
  void run;
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
  /** 正常任务的命令 */
  buildArgs(prompt: string, execution?: ExecutionMode): string[];
  /** 续跑命令：恢复会话并传递用户反馈 */
  buildResumeArgs(sessionId: string, feedback: string, execution?: ExecutionMode): string[];
  /** 单行事件解析：返回 null 表示该行不是关心的 JSONL 事件 */
  parseLine(line: string): AdapterEvent | null;
  /** 启动前凭证自检命令（如 test -f auth.json），exit 0 为通过 */
  authCheckArgs(): string[];
}

export interface AdapterEvent {
  type: 'session' | 'agent_message' | 'error' | 'other';
  sessionId?: string;
  text?: string;
}

/** 通知器：daemon 只发领域事件，实现方决定发到哪（Console/钉钉/企微/邮件…） */
export type NotifyEvent = { runId: number } & (
  | { kind: 'run.started'; task: Task; project: Project }
  | { kind: 'run.succeeded'; task: Task; project: Project; summary: RunSummary }
  | { kind: 'run.failed'; task: Task; project: Project; reason: string; retryViaCli?: boolean }
  | { kind: 'run.blocked'; task: Task; project: Project; blockedKind: BlockedKind; question?: string; retryViaCli?: boolean });

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
  type: 'resume' | 'retry' | 'cancel' | 'status' | 'detail' | 'help' | 'run' | 'draft' | 'projects';
  taskId?: number;
  feedback?: string;
  /** 新任务描述，或启动草稿时给已有任务追加的说明 */
  prompt?: string;
  projectId?: number;
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
