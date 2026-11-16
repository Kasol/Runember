/** 通知去重基类（独立模块，避免 notify.ts ↔ dingtalk.ts 循环引用） */
import type { Notifier, NotifyEvent } from '@agentdesk/core';

/** 同一次运行的同类通知在窗口期内只发一次。 */
export abstract class DedupedNotifier implements Notifier {
  abstract readonly name: string;
  private lastAt = new Map<string, number>();
  constructor(private windowMs = 30 * 60 * 1000) {}

  async notify(event: NotifyEvent): Promise<void> {
    if (this.windowMs === 0) return this.send(event);
    const key = `${event.runId}:${event.kind}`;
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
}
