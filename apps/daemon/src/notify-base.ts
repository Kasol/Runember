/** 通知去重基类（独立模块，避免 notify.ts ↔ dingtalk.ts 循环引用） */
import type { Notifier, NotifyEvent } from '@agentdesk/core';

/** 同一任务同一事件类别在窗口期内只放行一次（防骚扰；各渠道实现共用） */
export abstract class DedupedNotifier implements Notifier {
  abstract readonly name: string;
  private lastAt = new Map<string, number>();
  constructor(private windowMs = 30 * 60 * 1000) {}

  async notify(event: NotifyEvent): Promise<void> {
    const key = `${event.task.id}:${event.kind}`;
    const now = Date.now();
    if (now - (this.lastAt.get(key) ?? 0) < this.windowMs) return;
    this.lastAt.set(key, now);
    await this.send(event);
  }
  protected abstract send(event: NotifyEvent): Promise<void>;
}
