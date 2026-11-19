import { createHash } from 'node:crypto';
import type { NotifyEvent, UiLanguage } from '@agentdesk/core';
import type { ReportLink } from './dingtalk-reports.js';

export interface DeliveryStorage {
  getDelivery(id: string): string | undefined;
  saveDelivery(id: string, payload: string): void;
  listDeliveries(prefix: string): Array<{ id: string; payload: string }>;
}

interface Job {
  id: string; runId: number; state: 'pending' | 'fallback' | 'complete' | 'expired';
  event?: NotifyEvent; language: UiLanguage; createdAt: number; nextAt: number; attempts: number;
  url?: string; lastError?: string;
  fallbackAt?: number;
}

export interface ReportDeliveryOptions {
  storage?: DeliveryStorage;
  identity: unknown;
  publish: ReportLink;
  result: (event: NotifyEvent, language: UiLanguage, url?: string, reportFailed?: boolean) => Promise<void>;
  link: (event: NotifyEvent, language: UiLanguage, url: string) => Promise<void>;
  accept?: (event: NotifyEvent) => boolean;
  waitMs?: number; retryMs?: number; lifetimeMs?: number; now?: () => number;
}

/** Durable channel-specific receipts. Report work never occupies an Agent execution slot. */
export class ReportDelivery {
  private prefix: string;
  private active = new Map<string, Promise<void>>();
  private memory = new Map<string, string>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(private options: ReportDeliveryOptions) {
    this.prefix = createHash('sha256').update(JSON.stringify(options.identity)).digest('hex').slice(0, 24) + ':';
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private save(job: Job) {
    const payload = JSON.stringify(job);
    if (this.options.storage) this.options.storage.saveDelivery(job.id, payload); else this.memory.set(job.id, payload);
  }
  private get(id: string): Job | undefined {
    const raw = this.options.storage?.getDelivery(id) ?? this.memory.get(id);
    return raw ? JSON.parse(raw) : undefined;
  }
  start(): void {
    if (!this.options.storage || this.timer) return;
    this.stopped = false;
    const sweep = () => void this.sweep().catch(error => console.warn('[dingtalk-delivery] 无法读取待补发记录:', (error as Error).message));
    this.timer = setInterval(sweep, 30_000); this.timer.unref();
    sweep();
  }
  stop(): void { this.stopped = true; clearInterval(this.timer); this.timer = undefined; }
  async drain(): Promise<void> { while (this.active.size) await Promise.allSettled(this.active.values()); }
  retry(runId: number): number {
    const rows = this.options.storage?.listDeliveries(this.prefix) ?? [];
    let scheduled = 0;
    for (const row of rows) {
      const job: Job = JSON.parse(row.payload);
      if (job.runId !== runId || !job.event || job.state === 'complete' || this.active.has(job.id) || this.options.accept && !this.options.accept(job.event)) continue;
      if (job.state === 'expired') { job.state = 'fallback'; job.fallbackAt = this.now(); }
      job.nextAt = this.now(); this.save(job); scheduled++;
      void this.run(job, false).catch(error => console.warn(`[dingtalk-delivery] run=${runId} ${(error as Error).message}`));
    }
    return scheduled;
  }
  async sweep(): Promise<void> {
    if (this.stopped) return;
    const rows = this.options.storage?.listDeliveries(this.prefix) ?? [...this.memory].map(([id, payload]) => ({ id, payload }));
    for (const row of rows) {
      const job: Job = JSON.parse(row.payload);
      if (job.event && this.options.accept && !this.options.accept(job.event)) continue;
      if (this.active.size >= 3) break;
      if (['pending', 'fallback'].includes(job.state) && job.nextAt <= this.now() && !this.active.has(job.id)) {
        void this.run(job, false).catch(error => console.warn(`[dingtalk-delivery] run=${job.runId} ${(error as Error).message}`));
      }
    }
  }
  deliver(event: NotifyEvent, language: UiLanguage): Promise<void> {
    const id = `${this.prefix}${event.runId}:${event.kind}`;
    const job = this.get(id) ?? { id, runId: event.runId, state: 'pending', event, language,
      createdAt: this.now(), nextAt: this.now(), attempts: 0 } as Job;
    if (job.state === 'complete' || job.state === 'expired') return Promise.resolve();
    this.save(job);
    return this.run(job, job.attempts === 0);
  }
  private run(job: Job, initial: boolean): Promise<void> {
    const existing = this.active.get(job.id); if (existing) return existing;
    const operation = this.process(job, initial);
    this.active.set(job.id, operation);
    void operation.finally(() => this.active.delete(job.id)).catch(() => {});
    return operation;
  }
  private async process(job: Job, initial: boolean): Promise<void> {
    if (!job.event) return;
    if (job.state === 'fallback' && this.now() - (job.fallbackAt ?? job.createdAt) >= (this.options.lifetimeMs ?? 24 * 60 * 60_000)) {
      job.state = 'expired'; this.save(job); return;
    }
    job.attempts++; this.save(job);
    const deadlineAt = this.now() + (this.options.waitMs ?? 180_000);
    let reportError: unknown;
    if (!job.url) {
      for (let attempt = 0; ; attempt++) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          job.url = await Promise.race([
            this.options.publish(job.event, job.language, { deadlineAt }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('报告等待已达上限，将在后台重试。')), Math.max(1, deadlineAt - this.now())); }),
          ]);
          if (!job.url) throw new Error('文档服务未返回报告链接。');
          this.save(job); break;
        } catch (error) { reportError = error; job.lastError = (error as Error).message.slice(0, 500); }
        finally { clearTimeout(timer); }
        const delay = [10_000, 20_000][attempt];
        if (!initial || delay === undefined || !(reportError as { retryable?: boolean })?.retryable || this.now() + delay >= deadlineAt) break;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    try {
      if (job.url) {
        if (job.state === 'fallback') await this.options.link(job.event, job.language, job.url);
        else await this.options.result(job.event, job.language, job.url);
        job.state = 'complete'; job.event = undefined; job.lastError = undefined; this.save(job);
      } else if (job.state === 'pending') {
        await this.options.result(job.event, job.language, undefined, true);
        job.state = 'fallback'; job.fallbackAt = this.now(); this.save(job);
      }
    } catch (error) {
      job.lastError = '通知发送未确认成功，将重试。';
      job.nextAt = this.now() + (this.options.retryMs ?? 60_000); this.save(job);
      throw error;
    }
    if (job.state !== 'complete') {
      job.nextAt = this.now() + (this.options.retryMs ?? Math.min(15 * 60_000, 60_000 * 2 ** Math.min(job.attempts - 1, 4)));
      this.save(job);
      if (reportError && initial) console.warn(`[dingtalk-delivery] task=${job.event?.task.id} run=${job.runId} 报告暂不可用，已保留补发记录：${job.lastError}`);
    }
  }
}
