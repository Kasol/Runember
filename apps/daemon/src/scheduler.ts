/**
 * 调度器 —— 5s tick + 三层闸门（全局并发 → 项目锁 → Run 占用）。
 * v1 并发=1 来自配置而非代码；放开并行 = 改配置，本文件零改动（用户指令：不写死串行）。
 */
import { canStart } from '@agentdesk/core';
import type { Run } from '@agentdesk/core';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Runner } from './runner.js';
import type { Store } from './store.js';
import type { AppConfig } from './config.js';

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private stopped = false;
  private jobs = new Map<number, { workspace: string; done: Promise<void> }>();
  private recovering = new Set<number>();

  constructor(
    private cfg: AppConfig,
    private store: Store,
    private runner: Runner,
  ) {}

  start(): void {
    for (const run of this.store.activeRuns()) this.recovering.add(run.id);
    this.stopped = false;
    this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.scheduler.tickMs);
    console.log(`⏱️  调度器已启动（tick=${this.cfg.scheduler.tickMs}ms 并发=${this.cfg.scheduler.concurrency}）`);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.jobs.values()].map(job => job.done));
    await this.recoveringTick;
  }

  /** API 创建/resume 任务后立即触发一次调度（不等下个 tick） */
  tickNow(): void {
    void this.tick();
  }

  stopRun(run: Run): void {
    if (this.jobs.has(run.task_id)) void this.runner.requestStop(run);
    else this.tickNow();
  }

  private recoveringTick?: Promise<void>;
  private async reconcile(): Promise<void> {
    for (const id of this.recovering.keys()) {
      try {
        const current = this.store.getRun(id);
        if (!current || await this.runner.recoverRun(current)) this.recovering.delete(id);
      } catch (error) {
        console.error(`Run #${id} 暂无法核对执行器状态:`, error);
      }
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      for (const run of this.store.activeRuns()) {
        if (run.cancellation && this.jobs.has(run.task_id)) void this.runner.requestStop(run);
      }
      this.recoveringTick = this.reconcile();
      await this.recoveringTick;
      if (this.stopped) return;
      const queued = this.store.dispatchableTasks(Date.now());
      if (!queued.length) return;

      const occupied = new Set(this.jobs.keys());
      const busyPaths = new Set([...this.jobs.values()].map(job => job.workspace));
      for (const run of this.store.activeRuns()) {
        occupied.add(run.task_id);
        const task = this.store.getTask(run.task_id);
        const project = task && this.store.getProject(task.project_id);
        if (project) busyPaths.add(workspaceKey(project.workspace_path));
      }
      const gates = {
        concurrency: this.cfg.scheduler.concurrency,
        activeRuns: occupied.size,
        busyProjects: new Set<number>(),
      };
      for (const task of queued) {
        if (!canStart(task, gates)) continue;
        const project = this.store.getProject(task.project_id);
        if (!project) {
          this.store.setTaskStatus(task.id, 'failed');
          continue;
        }
        const workspace = workspaceKey(project.workspace_path);
        if (occupied.has(task.id) || busyPaths.has(workspace)) continue;
        gates.activeRuns++;
        gates.busyProjects.add(task.project_id);
        busyPaths.add(workspace);
        console.log(`▶ 调度: 任务#${task.id} 出队`);
        const done = this.runner.execute(task.id).catch(error => {
          console.error(`任务 #${task.id} 异常:`, error);
          for (const run of this.store.activeRuns().filter(run => run.task_id === task.id)) {
            this.recovering.add(run.id);
          }
        }).finally(() => {
          this.jobs.delete(task.id);
          this.tickNow();
        });
        this.jobs.set(task.id, { workspace, done });
      }
    } catch (error) {
      console.error('调度失败:', error);
    } finally {
      this.ticking = false;
    }
  }
}

function workspaceKey(path: string): string {
  let absolute = resolve(path);
  try { absolute = realpathSync.native(absolute); } catch { /* 让执行器报告不可访问的路径 */ }
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
