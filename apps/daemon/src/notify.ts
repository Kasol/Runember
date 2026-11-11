/**
 * 通知层：daemon 只发领域事件（NotifyEvent），Notifier 实现决定发到哪。
 * M1 = ConsoleNotifier；M3 = DingTalkNotifier（配置 notify.channels 即启用）。
 */
import { EventEmitter } from 'node:events';
import type { Notifier, NotifyEvent } from '@agentdesk/core';
import { DedupedNotifier } from './notify-base.js';
import { DingTalkNotifier } from './dingtalk.js';

export { DedupedNotifier };

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

/** 渠道工厂：按 notify.channels[].type 装配。新增渠道（企微/邮件/…）= 在这里加一个 case */
export function buildNotifiers(
  channels: Array<Record<string, unknown>>,
  publicUrl: string,
): Notifier[] {
  const list: Notifier[] = [new ConsoleNotifier()];
  for (const ch of channels) {
    if (ch.type === 'dingtalk-webhook') {
      const token = String(ch.access_token ?? '');
      if (!token) { console.warn('[notify] dingtalk 渠道缺少 access_token，已跳过'); continue; }
      list.push(new DingTalkNotifier(
        { access_token: token, secret: ch.secret ? String(ch.secret) : undefined,
          events: ch.events as string[] | undefined, atAll: !!ch.atAll },
        publicUrl,
      ));
    } else {
      console.warn(`[notify] 未知渠道类型: ${String(ch.type)}，已跳过`);
    }
  }
  return list;
}
