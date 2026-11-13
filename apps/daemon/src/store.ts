/**
 * 存储：node:sqlite（Node 内置，零原生依赖 —— 别人 npm install 即可用）。
 * 队列就是 tasks 表本身：调度器轮询 status='queued'，不引入外部 MQ。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, TaskStatus, Run, Project } from '@agentdesk/core';

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'agentdesk.db'));
    this.db.exec('PRAGMA journal_mode = WAL;');
    // 轻量迁移：老库补 extra_packages / mcp_servers / draft_order 列
    const cols = (this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map(c => c.name);
    if (!cols.includes('extra_packages')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN extra_packages TEXT');
    }
    if (!cols.includes('mcp_servers')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN mcp_servers TEXT');
    }
    if (!cols.includes('execution')) {
      this.db.exec("ALTER TABLE projects ADD COLUMN execution TEXT NOT NULL DEFAULT 'capability'");
    }
    const tcols = (this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(c => c.name);
    if (!tcols.includes('draft_order')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN draft_order INTEGER');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        workspace_path TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'codex',
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
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        kind TEXT NOT NULL DEFAULT 'normal',
        session_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        exit_code INTEGER,
        blocked_kind TEXT,
        log_path TEXT,
        summary_json TEXT,
        started_at TEXT,
        ended_at TEXT
      );
    `);
  }

  // ── projects ──
  addProject(
    name: string, workspacePath: string, agentId: string,
    execution: string = 'capability', extraPackages?: string[], mcpServers?: string[],
  ): Project {
    const r = this.db.prepare(
      'INSERT INTO projects(name, workspace_path, agent_id, execution, extra_packages, mcp_servers, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(name, workspacePath, agentId, execution,
      extraPackages?.length ? JSON.stringify(extraPackages) : null,
      mcpServers?.length ? JSON.stringify(mcpServers) : null,
      new Date().toISOString());
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
    const status = opts?.draft ? 'draft' : 'queued';
    let draftOrder: number | null = null;
    if (opts?.draft) {
      const row = this.db.prepare(
        "SELECT MAX(draft_order) AS m FROM tasks WHERE status='draft'",
      ).get() as { m: number | null };
      draftOrder = (row?.m ?? 0) + 1;
    }
    const r = this.db.prepare(
      'INSERT INTO tasks(project_id, prompt, status, draft_order, created_at) VALUES (?,?,?,?,?)',
    ).run(projectId, prompt, status, draftOrder, new Date().toISOString());
    return this.getTask(Number(r.lastInsertRowid))!;
  }
  getTask(id: number): Task | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Task | undefined;
  }
  listTasks(status?: TaskStatus): Task[] {
    return (status
      ? this.db.prepare('SELECT * FROM tasks WHERE status=? ORDER BY id').all(status)
      : this.db.prepare('SELECT * FROM tasks ORDER BY id DESC LIMIT 200').all()) as unknown as Task[];
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
    return this.db.prepare(
      "SELECT * FROM tasks WHERE status='draft' ORDER BY draft_order, id",
    ).all() as unknown as Task[];
  }
  setPendingFeedback(id: number, feedback: string | null): void {
    this.db.prepare('UPDATE tasks SET pending_feedback=? WHERE id=?').run(feedback, id);
  }

  // ── runs ──
  insertRun(taskId: number, kind: 'normal' | 'resume'): Run {
    const r = this.db.prepare('INSERT INTO runs(task_id, kind, status) VALUES (?,?,?)')
      .run(taskId, kind, 'starting');
    return this.getRun(Number(r.lastInsertRowid))!;
  }
  getRun(id: number): Run | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Run | undefined;
  }
  runsOfTask(taskId: number): Run[] {
    return this.db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY id').all(taskId) as unknown as Run[];
  }
  /** 任务最近一次携带 session 的 run —— resume 的钥匙 */
  lastSessionOfTask(taskId: number): string | undefined {
    const row = this.db.prepare(
      'SELECT session_id FROM runs WHERE task_id=? AND session_id IS NOT NULL ORDER BY id DESC LIMIT 1',
    ).get(taskId) as { session_id: string } | undefined;
    return row?.session_id;
  }
  updateRun(id: number, patch: Partial<Run>): void {
    const cur = this.getRun(id)!;
    const next = { ...cur, ...patch };
    this.db.prepare(
      'UPDATE runs SET status=?, session_id=?, exit_code=?, blocked_kind=?, log_path=?, summary_json=?, started_at=?, ended_at=? WHERE id=?',
    ).run(next.status, next.session_id ?? null, next.exit_code ?? null, next.blocked_kind ?? null,
      next.log_path ?? null, next.summary_json ?? null, next.started_at ?? null, next.ended_at ?? null, id);
  }
  runningRunCount(): number {
    return Number((this.db.prepare(
      "SELECT COUNT(*) AS c FROM runs WHERE status IN ('starting','running')",
    ).get() as { c: number }).c);
  }
  runningProjectIds(): number[] {
    return (this.db.prepare(
      "SELECT DISTINCT t.project_id AS pid FROM runs r JOIN tasks t ON t.id=r.task_id WHERE r.status IN ('starting','running')",
    ).all() as Array<{ pid: number }>).map(r => r.pid);
  }
}
