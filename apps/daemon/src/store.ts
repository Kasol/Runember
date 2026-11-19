/**
 * 存储：node:sqlite（Node 内置，零原生依赖 —— 别人 npm install 即可用）。
 * 队列就是 tasks 表本身：调度器轮询 status='queued'，不引入外部 MQ。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { taskView, type Task, type TaskStatus, type TaskView, type Run, type Project, type RunActivity } from '@agentdesk/core';
import type { MergePlan, MergeState } from './merge.js';

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'agentdesk.db'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    // 轻量迁移：老库补 extra_packages / mcp_servers / draft_order 列
    const cols = (this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map(c => c.name);
    if (cols.length && !cols.includes('extra_packages')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN extra_packages TEXT');
    }
    if (cols.length && !cols.includes('mcp_servers')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN mcp_servers TEXT');
    }
    if (cols.length && !cols.includes('execution')) {
      this.db.exec("ALTER TABLE projects ADD COLUMN execution TEXT NOT NULL DEFAULT 'capability'");
    }
    const tcols = (this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(c => c.name);
    if (tcols.length && !tcols.includes('draft_order')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN draft_order INTEGER');
    }
    if (tcols.length && !tcols.includes('partial_remaining')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN partial_remaining TEXT');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        workspace_path TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'codex',
        execution TEXT NOT NULL DEFAULT 'capability',
        extra_packages TEXT,
        mcp_servers TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        pending_feedback TEXT,
        draft_order INTEGER,
        partial_remaining TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'normal',
        session_id TEXT,
        checkpoint_sha TEXT,
        worker_json TEXT,
        cancellation_json TEXT,
        execution_json TEXT,
        recent_activity_json TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        exit_code INTEGER,
        blocked_kind TEXT,
        log_path TEXT,
        summary_json TEXT,
        started_at TEXT,
        ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS merge_tasks(
        task_id INTEGER PRIMARY KEY,
        plan TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT '{}',
        next_run_at INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS settings(
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    const runCols = this.db.prepare('PRAGMA table_info(runs)').all() as Array<{ name: string }>;
    for (const field of ['checkpoint_sha', 'worker_json', 'cancellation_json', 'execution_json', 'recent_activity_json']) {
      if (!runCols.some(col => col.name === field)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${field} TEXT`);
    }
    for (const [table, fields] of [['projects', ['model', 'reasoning_effort']], ['tasks', ['agent_id', 'model', 'execution', 'reasoning_effort']], ['runs', ['agent_id', 'model', 'reasoning_effort']]] as const) {
      const names = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      for (const field of fields) if (!names.some(column => column.name === field)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${field} TEXT`);
    }
  }

  // ── projects ──
  getSetting(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value;
  }
  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }
  addProject(
    name: string, workspacePath: string, agentId: string,
    execution: string = 'capability', extraPackages?: string[], mcpServers?: string[], model?: string | null, reasoningEffort?: string | null,
  ): Project {
    const r = this.db.prepare(
      'INSERT INTO projects(name, workspace_path, agent_id, execution, extra_packages, mcp_servers, created_at, model, reasoning_effort) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(name, workspacePath, agentId, execution,
      extraPackages?.length ? JSON.stringify(extraPackages) : null,
      mcpServers?.length ? JSON.stringify(mcpServers) : null,
      new Date().toISOString(), model || null, reasoningEffort || null);
    return this.getProject(Number(r.lastInsertRowid))!;
  }
  getProject(id: number): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as any;
    if (!row) return undefined;
    return this.parseProject(row);
  }
  findProject(name: string): Project | undefined {
    const row = this.db.prepare('SELECT * FROM projects WHERE name=?').get(name) as any;
    return row ? this.parseProject(row) : undefined;
  }
  updateProject(id: number, patch: { agent_id?: string; model?: string | null; reasoning_effort?: string | null; execution?: string; extraPackages?: string[]; mcpServers?: string[] }): Project {
    if (patch.agent_id) this.db.prepare('UPDATE projects SET agent_id=? WHERE id=?').run(patch.agent_id, id);
    if (patch.model !== undefined) this.db.prepare('UPDATE projects SET model=? WHERE id=?').run(patch.model || null, id);
    if (patch.reasoning_effort !== undefined) this.db.prepare('UPDATE projects SET reasoning_effort=? WHERE id=?').run(patch.reasoning_effort || null, id);
    if (patch.execution) this.db.prepare('UPDATE projects SET execution=? WHERE id=?').run(patch.execution, id);
    if (patch.extraPackages !== undefined) {
      this.db.prepare('UPDATE projects SET extra_packages=? WHERE id=?')
        .run(patch.extraPackages?.length ? JSON.stringify(patch.extraPackages) : null, id);
    }
    if (patch.mcpServers !== undefined) {
      this.db.prepare('UPDATE projects SET mcp_servers=? WHERE id=?')
        .run(patch.mcpServers?.length ? JSON.stringify(patch.mcpServers) : null, id);
    }
    return this.getProject(id)!;
  }
  deleteProject(id: number): void {
    this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
  }
  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY id').all() as any[]).map(r => this.parseProject(r));
  }

  /** JSON 列（extra_packages/mcp_servers）解析：TEXT → 数组 */
  private parseProject(row: any): Project {
    const parse = (v: unknown): string[] | undefined => {
      if (typeof v !== 'string' || !v) return undefined;
      try { const a = JSON.parse(v); return Array.isArray(a) ? a : undefined; } catch { return undefined; }
    };
    return {
      ...row,
      execution: row.execution ?? 'capability',
      extraPackages: parse(row.extra_packages),
      mcpServers: parse(row.mcp_servers),
    } as Project;
  }

  // ── tasks ──
  /** draft=true 时任务以 draft 状态落库（不参与调度），draft_order 用于草稿排序 */
  addTask(projectId: number, prompt: string, opts?: { draft?: boolean }): Task {
    const project = this.getProject(projectId)!;
    const status = opts?.draft ? 'draft' : 'queued';
    let draftOrder: number | null = null;
    if (opts?.draft) {
      const row = this.db.prepare(
        "SELECT MAX(draft_order) AS m FROM tasks WHERE status='draft'",
      ).get() as { m: number | null };
      draftOrder = (row?.m ?? 0) + 1;
    }
    const r = this.db.prepare(
      'INSERT INTO tasks(project_id, prompt, status, draft_order, created_at, agent_id, model, execution, reasoning_effort) VALUES (?,?,?,?,?,?,?,?,?)',
    ).run(projectId, prompt, status, draftOrder, new Date().toISOString(), project.agent_id, project.model ?? null, project.execution ?? 'capability', project.reasoning_effort ?? null);
    return this.getTask(Number(r.lastInsertRowid))!;
  }
  addMergeTask(projectId: number, plan: MergePlan): Task {
    this.db.exec('BEGIN');
    try {
      const task = this.addTask(projectId, `自动化合并 ${plan.source} → ${plan.base}`);
      this.db.prepare('INSERT INTO merge_tasks(task_id, plan) VALUES (?,?)').run(task.id, JSON.stringify(plan));
      this.db.exec('COMMIT');
      return task;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  getMerge(id: number): { plan: MergePlan; state: MergeState } | undefined {
    const row = this.db.prepare('SELECT plan, state FROM merge_tasks WHERE task_id=?').get(id) as
      { plan: string; state: string } | undefined;
    return row && { plan: JSON.parse(row.plan), state: JSON.parse(row.state) };
  }
  saveMerge(id: number, state: MergeState): void {
    this.db.prepare('UPDATE merge_tasks SET state=? WHERE task_id=?').run(JSON.stringify(state), id);
  }
  deferMerge(id: number, nextRunAt: number): void {
    this.db.prepare('UPDATE merge_tasks SET next_run_at=? WHERE task_id=?').run(nextRunAt, id);
  }
  hasUnfinishedMerge(projectId: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM tasks t JOIN merge_tasks m ON t.id=m.task_id
      WHERE t.project_id=? AND t.status IN ('queued','running','blocked','failed') LIMIT 1`).get(projectId);
  }
  hasActiveTasks(projectId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM tasks WHERE project_id=? AND status IN ('queued','running') LIMIT 1").get(projectId);
  }
  dispatchableTasks(now: number): Task[] {
    return this.db.prepare(`SELECT t.* FROM tasks t LEFT JOIN merge_tasks m ON t.id=m.task_id
      WHERE t.status='queued' AND COALESCE(m.next_run_at, 0)<=? ORDER BY t.id`).all(now) as unknown as Task[];
  }
  getTask(id: number): Task | undefined {
    const task = this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Task | undefined;
    return task && this.taskBinding(task);
  }
  private taskBinding(task: Task): Task {
    return { ...task, agent_id: task.agent_id ?? 'codex', execution: task.execution ?? this.getProject(task.project_id)?.execution ?? 'capability' };
  }
  listTasks(status?: TaskStatus): Task[] {
    return (status
      ? this.db.prepare('SELECT * FROM tasks WHERE status=? ORDER BY id').all(status)
      : this.db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 200').all()) as unknown as Task[];
  }
  listTaskViews(status?: TaskStatus): TaskView[] {
    return this.listTasks(status).map(row => { const task = this.taskBinding(row); return taskView(task,
      task.status === 'blocked' || task.status === 'running' ? this.latestRun(task.id) : undefined); });
  }
  setTaskStatus(id: number, status: TaskStatus): void {
    this.db.prepare('UPDATE tasks SET status=? WHERE id=?').run(status, id);
    if (status !== 'draft') this.db.prepare('UPDATE tasks SET draft_order=NULL WHERE id=?').run(id);
  }
  /** 草稿操作：编辑提示词 / 移动顺序 */
  updateTaskPrompt(id: number, prompt: string): void {
    this.db.prepare('UPDATE tasks SET prompt=? WHERE id=?').run(prompt, id);
  }
  reorderDraft(id: number, beforeId: number | null): void {
    // 把 id 移到 beforeId 之前：重排剩余草稿的 draft_order
    const drafts = this.db.prepare(
      "SELECT id FROM tasks WHERE status='draft' ORDER BY draft_order, id",
    ).all() as Array<{ id: number }>;
    const list = drafts.map(d => d.id).filter(x => x !== id);
    const idx = beforeId ? list.indexOf(beforeId) : -1;
    if (idx >= 0) list.splice(idx, 0, id); else list.push(id);
    const upd = this.db.prepare('UPDATE tasks SET draft_order=? WHERE id=?');
    list.forEach((tid, i) => upd.run(i + 1, tid));
  }
  listDrafts(): Task[] {
    return (this.db.prepare(
      "SELECT * FROM tasks WHERE status='draft' ORDER BY draft_order, id",
    ).all() as unknown as Task[]).map(task => this.taskBinding(task));
  }
  setPendingFeedback(id: number, feedback: string | null): void {
    this.db.prepare('UPDATE tasks SET pending_feedback=? WHERE id=?').run(feedback, id);
  }

  // ── runs ──
  insertRun(taskId: number, kind: 'normal' | 'resume'): Run {
    const task = this.getTask(taskId)!;
    const r = this.db.prepare('INSERT INTO runs(task_id, kind, status, agent_id, model, reasoning_effort) VALUES (?,?,?,?,?,?)')
      .run(taskId, kind, 'starting', task.agent_id ?? 'codex', task.model ?? null, task.reasoning_effort ?? null);
    return this.getRun(Number(r.lastInsertRowid))!;
  }
  beginRun(taskId: number): Run | undefined {
    return this.transaction(() => {
      const task = this.getTask(taskId);
      if (task?.status !== 'queued') return;
      const run = this.insertRun(taskId, task.pending_feedback ? 'resume' : 'normal');
      this.db.prepare(`UPDATE tasks SET status='running', pending_feedback=NULL, partial_remaining=NULL
        WHERE id=?`).run(taskId);
      return run;
    });
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  finishRun(id: number, patch: Partial<Run>, status: TaskStatus, partial: string | null = null): void {
    this.transaction(() => {
      const run = this.getRun(id)!;
      this.updateRun(id, patch);
      this.db.prepare(`UPDATE tasks SET status=?,partial_remaining=?,draft_order=NULL
        WHERE id=? AND status='running'`).run(status, partial, run.task_id);
    });
  }
  requestCancellation(taskId: number, expectedRunId?: number): Run | undefined {
    return this.transaction(() => {
      if (this.getTask(taskId)?.status !== 'running') return;
      const run = this.latestRun(taskId);
      if (!run || (expectedRunId !== undefined && run.id !== expectedRunId)
        || (run.status !== 'starting' && run.status !== 'running')) return;
      if (run.cancellation) return run;
      if (run.execution) return;
      run.cancellation = { requestedAt: new Date().toISOString() };
      this.updateRun(run.id, { cancellation: run.cancellation });
      return run;
    });
  }
  interruptRun(run: Run): void {
    const isMerge = !!this.getMerge(run.task_id);
    this.finishRun(run.id, {
      status: 'blocked', blocked_kind: 'interrupted', ended_at: new Date().toISOString(),
      summary_json: JSON.stringify({
        diagnostic: isMerge ? 'daemon 中断，合并任务将从已保存进度继续。'
          : 'daemon 中断，执行器已退出，结果未知。请查看工作区和日志后决定是否继续。',
        filesChanged: [], diffStat: '',
      }),
    }, isMerge ? 'queued' : 'blocked');
  }
  private parseRun(row: (Run & {
    worker_json?: string; cancellation_json?: string; execution_json?: string; recent_activity_json?: string;
  }) | undefined): Run | undefined {
    if (!row) return undefined;
    const { worker_json, cancellation_json, execution_json, recent_activity_json, ...run } = row;
    return {
      ...run,
      worker: worker_json ? JSON.parse(worker_json) as Run['worker'] : undefined,
      cancellation: cancellation_json ? JSON.parse(cancellation_json) as Run['cancellation'] : undefined,
      execution: execution_json ? JSON.parse(execution_json) as Run['execution'] : undefined,
    };
  }
  getRun(id: number): Run | undefined {
    return this.parseRun(this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Run | undefined);
  }
  latestRun(taskId: number): Run | undefined {
    return this.parseRun(this.db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY id DESC LIMIT 1').get(taskId) as Run | undefined);
  }
  recentRunActivities(runId: number): RunActivity[] {
    const row = this.db.prepare('SELECT recent_activity_json FROM runs WHERE id=?').get(runId) as
      { recent_activity_json: string | null } | undefined;
    return row?.recent_activity_json ? JSON.parse(row.recent_activity_json) as RunActivity[] : [];
  }
  recordRunActivity(runId: number, activity: RunActivity): void {
    const recent = this.recentRunActivities(runId);
    const previous = recent.find(item => item.key === activity.key && item.kind === activity.kind);
    if (!activity.detail && previous?.detail) activity = { ...activity, detail: previous.detail };
    if (previous && ((previous.phase === activity.phase && previous.detail === activity.detail)
      || (previous.phase !== 'started' && activity.phase === 'started'))) return;
    const next = [...recent.filter(item => item !== previous), activity].slice(-10);
    this.db.prepare('UPDATE runs SET recent_activity_json=? WHERE id=?').run(JSON.stringify(next), runId);
  }
  runsOfTask(taskId: number): Run[] {
    return (this.db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY id').all(taskId) as unknown as Run[])
      .map(row => this.parseRun(row)!);
  }
  activeRuns(): Run[] {
    return (this.db.prepare(`SELECT * FROM runs WHERE status IN ('starting','running')`).all() as unknown as Run[])
      .map(row => this.parseRun(row)!);
  }
  /** 任务最近一次携带 session 的 run —— resume 的钥匙 */
  lastSessionOfTask(taskId: number): string | undefined {
    const agent = this.getTask(taskId)?.agent_id ?? 'codex';
    const row = this.db.prepare(
      "SELECT session_id FROM runs WHERE task_id=? AND session_id IS NOT NULL AND COALESCE(agent_id,'codex')=? ORDER BY id DESC LIMIT 1",
    ).get(taskId, agent) as { session_id: string } | undefined;
    return row?.session_id;
  }
  updateRun(id: number, patch: Partial<Run>): void {
    const cur = this.getRun(id)!;
    const next = { ...cur, ...patch };
    this.db.prepare(
      'UPDATE runs SET status=?, session_id=?, checkpoint_sha=?, worker_json=?, cancellation_json=?, execution_json=?, exit_code=?, blocked_kind=?, log_path=?, summary_json=?, started_at=?, ended_at=? WHERE id=?',
    ).run(next.status, next.session_id ?? null, next.checkpoint_sha ?? null, next.worker ? JSON.stringify(next.worker) : null,
      next.cancellation ? JSON.stringify(next.cancellation) : null, next.execution ? JSON.stringify(next.execution) : null,
      next.exit_code ?? null, next.blocked_kind ?? null,
      next.log_path ?? null, next.summary_json ?? null, next.started_at ?? null, next.ended_at ?? null, id);
  }
  close(): void {
    this.db.close();
  }
}
