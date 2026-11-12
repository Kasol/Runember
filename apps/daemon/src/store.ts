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
    // 轻量迁移：老库补 extra_packages 列
    const cols = (this.db.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map(c => c.name);
    if (!cols.includes('extra_packages')) {
      this.db.exec('ALTER TABLE projects ADD COLUMN extra_packages TEXT');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        workspace_path TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'codex',
        extra_packages TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        pending_feedback TEXT,
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
  addProject(name: string, workspacePath: string, agentId: string, extraPackages?: string[]): Project {
    const r = this.db.prepare(
      'INSERT INTO projects(name, workspace_path, agent_id, extra_packages, created_at) VALUES (?,?,?,?,?)',
    ).run(name, workspacePath, agentId, extraPackages?.length ? JSON.stringify(extraPackages) : null, new Date().toISOString());
    return this.getProject(Number(r.lastInsertRowid))!;
  }
  getProject(id: number): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as Project | undefined;
  }
  findProject(name: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE name=?').get(name) as Project | undefined;
  }
  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY id').all() as unknown as Project[];
  }

  // ── tasks ──
  addTask(projectId: number, prompt: string): Task {
    const r = this.db.prepare(
      'INSERT INTO tasks(project_id, prompt, status, created_at) VALUES (?,?,?,?)',
    ).run(projectId, prompt, 'queued', new Date().toISOString());
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
