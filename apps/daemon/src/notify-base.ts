/** 通知去重基类（独立模块，避免 notify.ts ↔ dingtalk.ts 循环引用） */
import type { Notifier, NotifyEvent } from '@agentdesk/core';

/** 同一次运行的同类通知在窗口期内只发一次。 */
export abstract class DedupedNotifier implements Notifier {
  abstract readonly name: string;
  private lastAt = new Map<string, number>();
  private sending = new Map<number, Promise<void>>();
  constructor(private windowMs = 30 * 60 * 1000) {}

  async notify(event: NotifyEvent): Promise<void> {
    if (this.windowMs === 0) return this.send(event);
    const episode = event.kind === 'run.connection_warning' || event.kind === 'run.connection_recovered' ? ':' + (event.connection.source ?? event.connection.state) + ':' + event.connection.since : '';
    const key = `${event.runId}:${event.kind}${episode}`;
    const now = Date.now();
    for (const [entry, at] of this.lastAt) {
      if (now - at >= this.windowMs) this.lastAt.delete(entry);
    }
    if (this.lastAt.has(key)) return;
    this.lastAt.set(key, now);
    try {
      await this.send(event);
    } catch (error) {
      if (this.lastAt.get(key) === now) this.lastAt.delete(key);
      throw error;
    }
  }
  protected abstract send(event: NotifyEvent): Promise<void>;
  /** Keep transport order for one Run; report preparation remains independent. */
  protected ordered(runId: number, send: () => Promise<void>): Promise<void> {
    const previous = this.sending.get(runId) ?? Promise.resolve();
    const current = previous.catch(()=>{}).then(send);
    this.sending.set(runId,current);
    void current.finally(()=>{if(this.sending.get(runId)===current)this.sending.delete(runId)}).catch(()=>{});
    return current;
  }
}
