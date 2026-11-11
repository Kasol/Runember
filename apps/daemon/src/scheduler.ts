/**
 * 调度器 —— 5s tick + 三层闸门（全局并发 → 项目锁 → Run 占用）。
 * v1 并发=1 来自配置而非代码；放开并行 = 改配置，本文件零改动（用户指令：不写死串行）。
 */
import { canStart } from '@agentdesk/core';
import type { Runner } from './runner.js';
import type { Store } from './store.js';
import type { AppConfig } from './config.js';

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private inFlightTasks = new Set<number>();
  private inFlightProjects = new Set<number>();

  constructor(
    private cfg: AppConfig,
    private store: Store,
    private runner: Runner,
  ) {}

  start(): void {
    this.tick();
    this.timer = setInterval(() => void this.tick(), this.cfg.scheduler.tickMs);
    console.log(`⏱️  调度器已启动（tick=${this.cfg.scheduler.tickMs}ms 并发=${this.cfg.scheduler.concurrency}）`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** API 创建/resume 任务后立即触发一次调度（不等下个 tick） */
  tickNow(): void {
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const queued = this.store.listTasks('queued');
      if (!queued.length) return;

      const gates = {
        concurrency: this.cfg.scheduler.concurrency,
        activeRuns: this.store.runningRunCount() + this.inFlightTasks.size,
        busyProjects: new Set([...this.store.runningProjectIds(), ...this.inFlightProjects]),
      };
      for (const task of queued) {
        if (!canStart(task, gates)) continue;
        this.inFlightTasks.add(task.id);
        this.inFlightProjects.add(task.project_id);
        gates.activeRuns++;
        gates.busyProjects.add(task.project_id);
        console.log(`▶ 调度: 任务#${task.id} 出队`);
        void this.runner.execute(task.id).finally(() => {
          this.inFlightTasks.delete(task.id);
          this.inFlightProjects.delete(task.project_id);
        });
      }
    } finally {
      this.ticking = false;
    }
  }
}
