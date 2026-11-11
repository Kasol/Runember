/**
 * 通知层：daemon 只发领域事件（NotifyEvent），Notifier 实现决定发到哪。
 * M1 = ConsoleNotifier（终端打印）；M3 = DingTalkNotifier（加配置即启用，零核心改动）。
 * 防骚扰策略（同 Task 同 blocked_kind 30min 去重）做在这层的基类里，渠道实现不重复写。
 */
import { EventEmitter } from 'node:events';
import type { Notifier, NotifyEvent } from '@agentdesk/core';

export class EventBus {
  private bus = new EventEmitter();

  constructor(notifiers: Notifier[]) {
    this.bus.on('event', (event: NotifyEvent) => {
      for (const n of notifiers) {
        n.notify(event).catch(e => console.error(`[notify:${n.name}] 发送失败:`, e?.message ?? e));
      }
    });
  }

  emit(event: NotifyEvent): void {
    this.bus.emit('event', event);
  }
}

/** 去重基类：同一任务同一事件类别在窗口期内只放行一次 */
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

export class ConsoleNotifier extends DedupedNotifier {
  readonly name = 'console';
  constructor() { super(0); } // 控制台不打扰原则，本地全程可见，不去重

  protected async send(event: NotifyEvent): Promise<void> {
    const t = `任务#${event.task.id}[${event.project.name}]`;
    switch (event.kind) {
      case 'run.started':
        console.log(`🔔 ${t} 开始执行`);
        break;
      case 'run.succeeded':
        console.log(`✅ ${t} 完成 —— ${event.summary.agentMessage?.slice(0, 120) ?? ''}`);
        break;
      case 'run.blocked':
        console.log(`⚠️  ${t} 阻塞(${event.blockedKind})${event.question ? '：' + event.question : ''}`);
        break;
      case 'run.failed':
        console.log(`❌ ${t} 失败：${event.reason}`);
        break;
    }
  }
}

/** M3 预告：DingTalkNotifier 只需继承 DedupedNotifier 实现 send()，配置 notify.channels 即启用 */
export function buildNotifiers(channels: Array<Record<string, unknown>>): Notifier[] {
  const list: Notifier[] = [new ConsoleNotifier()];
  for (const ch of channels) {
    // switch ((ch as any).type) { case 'dingtalk-webhook': list.push(new DingTalkNotifier(...)); }
    void ch;
  }
  return list;
}
