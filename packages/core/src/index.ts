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
  | 'unknown_error';

export interface Project {
  id: number;
  name: string;
  /** host-dir 模式：宿主机上的项目绝对路径（bind mount 源） */
  workspace_path: string;
  agent_id: AgentId;
  /** 执行后端：docker（默认，隔离）| native（codex 直接跑宿主，原生速度/零播种） */
  execution?: 'docker' | 'native';
  /** 项目级系统依赖声明（依赖三层通道：宿主 daemon 预装进项目专属镜像） */
  extraPackages?: string[];
  /** 项目声明的 MCP server 名（daemon 渲染进容器 config.toml，agent 会话内可用） */
  mcpServers?: string[];
  created_at: string;
}

export interface Task {
  id: number;
  project_id: number;
  prompt: string;
  status: TaskStatus;
  /** resume 时携带的人工反馈；runner 据此决定是新会话还是续会话 */
  pending_feedback?: string;
  created_at: string;
}

export interface Run {
  id: number;
  task_id: number;
  kind: 'normal' | 'resume';
  /** adapter 会话 id（codex thread id），续跑的钥匙 */
  session_id?: string;
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
}

// ─────────────────────────── 阻塞协议 ───────────────────────────

/** agent 主动声明"需要人"的约定标记（注入到任务 prompt 的契约里） */
export const AGENTCTL_MARKER = '###AGENTCTL_BLOCKED###';

/** 注入给 agent 的阻塞契约（由 adapter 拼进 prompt 尾部） */
export const AGENTCTL_CONTRACT = [
  '',
  '---',
  '[运行平台约定]',
  '1. 如果你在无法获得人类输入的情况下无法继续（缺凭据/需要产品决策/需要确认破坏性操作），',
  `请立即停止并输出一行以 ${AGENTCTL_MARKER} 开头的 JSON，形如：`,
  `${AGENTCTL_MARKER} {"reason":"...","question":"..."}，然后结束。不要猜测，不要空转。`,
  '2. 【环境规则】系统级依赖无法安装（沙箱只允许写工作区）。npm/pip 安装到项目本地目录是允许的；',
  '系统级缺失（apt/全局包/系统库/外部服务）时：不要反复重试安装，输出阻塞标记，',
  '并在 question 里精确列出缺失项与宿主侧安装方式（如 "apt-get install resvg" 或 "需预装 X"），一次问清。',
  '3. 平台未配置的外部工具（MCP/浏览器调试等）不存在，不要请求启用它们；',
  '若有合理的降级方案（如跳过某类验收），在 question 里给出明确的降级选项供人选择。',
  '4. 其余情况正常完成任务即可。不要执行 git push。',
].join('\n');

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
}

/** Run 终态判定：协议标记 > 超时 > 错误指纹 > 成败 */
export function classifyRun(input: ClassifyInput): ClassifyResult {
  if (input.killed) return { status: 'blocked', blockedKind: 'timeout' };
  if (input.lastAgentText.includes(AGENTCTL_MARKER)) {
    return { status: 'blocked', blockedKind: 'approval_needed' };
  }
  if (input.exitCode === 0) return { status: 'succeeded' };
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
  /** 正常任务的容器命令 */
  buildArgs(prompt: string): string[];
  /** 续跑命令：带完整上下文恢复会话并注入人的反馈 */
  buildResumeArgs(sessionId: string, feedback: string): string[];
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
export type NotifyEvent =
  | { kind: 'run.started'; task: Task; project: Project }
  | { kind: 'run.succeeded'; task: Task; project: Project; summary: RunSummary }
  | { kind: 'run.failed'; task: Task; project: Project; reason: string }
  | { kind: 'run.blocked'; task: Task; project: Project; blockedKind: BlockedKind; question?: string };

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
  type: 'resume' | 'retry' | 'cancel' | 'status' | 'help' | 'run';
  taskId?: number;
  feedback?: string;
  /** run 指令：新任务描述与目标项目 */
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
