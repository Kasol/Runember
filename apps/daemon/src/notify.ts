/**
 * 通知层：daemon 只发领域事件（NotifyEvent），Notifier 实现决定发到哪。
 * M1 = ConsoleNotifier；M3 = DingTalkNotifier（配置 notify.channels 即启用）。
 */
import { EventEmitter } from 'node:events';
import type { Notifier, NotifyEvent, UiLanguage } from '@agentdesk/core';
import { TASK_STATE_LABELS } from '@agentdesk/core';
import { DedupedNotifier } from './notify-base.js';
import { DingTalkNotifier } from './dingtalk.js';
import { DingTalkAppNotifier } from './dingtalk-app.js';
import type { ReportLink } from './dingtalk-reports.js';

export { DedupedNotifier };

export class EventBus {
  private bus = new EventEmitter();
  private pending = new Set<Promise<void>>();

  constructor(private notifiers: Notifier[]) {
    this.bus.on('event', (event: NotifyEvent) => {
      for (const n of notifiers) {
        const sent = n.notify(event).catch(e => console.error(`[notify:${n.name}] 发送失败:`, e?.message ?? e));
        this.pending.add(sent);
        void sent.finally(() => this.pending.delete(sent));
      }
    });
    for (const notifier of notifiers) notifier.start?.();
  }

  emit(event: NotifyEvent): void {
    this.bus.emit('event', event);
  }
  async drain(): Promise<void> {
    for (const notifier of this.notifiers) notifier.stop?.();
    while (this.pending.size) await Promise.allSettled(this.pending);
    await Promise.all(this.notifiers.map(notifier => notifier.drain?.()));
  }
}

export class ConsoleNotifier extends DedupedNotifier {
  readonly name = 'console';
  constructor() { super(0); } // 控制台不打扰原则，本地全程可见，不去重

  protected async send(event: NotifyEvent): Promise<void> {
    const t = `任务#${event.task.id}[${event.project.name}]`;
    const state = event.kind === 'run.started' || event.kind.startsWith('run.connection_') ? 'running' : event.kind === 'run.cancelled' ? 'cancelled'
      : event.details?.confirmation ? 'awaiting_confirmation' : 'ended';
    const detail = event.kind === 'run.connection_warning' ? event.connection.state === 'inactive' ? '长时间无可见活动，执行器仍在运行' : '连接重试超过 2 分钟，执行器仍在运行' : event.kind === 'run.connection_recovered' ? 'Agent 恢复有效活动'
      : event.details?.confirmation ?? event.details?.stage ?? '';
    console.log(`${TASK_STATE_LABELS[state]} ${t}${detail ? ' · ' + detail : ''}`);
  }
}

/** 渠道工厂：按 notify.channels[].type 装配。新增渠道（企微/邮件/…）= 在这里加一个 case */
export function buildNotifiers(
  channels: Array<Record<string, unknown>>,
  publicUrl: string,
  appCreds?: { clientId: string; clientSecret: string },
  reportLink?: ReportLink,
  language: (conversation?: string) => UiLanguage = () => 'zh-CN',
  deliveryStorage?: import('./report-delivery.js').DeliveryStorage,
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
        reportLink,
        () => language(),
        deliveryStorage,
      ));
    } else if (ch.type === 'dingtalk-app') {
      // 单机器人双职责渠道：复用 feedback.dingtalkStream 的应用凭证主动推群
      if (!appCreds) { console.warn('[notify] dingtalk-app 渠道需要 feedback.dingtalkStream 凭证，已跳过'); continue; }
      list.push(new DingTalkAppNotifier(
        appCreds.clientId, appCreds.clientSecret, publicUrl,
        (ch.events as string[] | undefined) ?? ['blocked', 'failed'],
        {
          conversationId: typeof ch.conversationId === 'string' ? ch.conversationId : undefined,
          robotCode: typeof ch.robotCode === 'string' ? ch.robotCode : undefined,
        },
        reportLink,
        () => language(typeof ch.conversationId === 'string' ? ch.conversationId : undefined),
        deliveryStorage,
      ));
    } else {
      console.warn(`[notify] 未知渠道类型: ${String(ch.type)}，已跳过`);
    }
  }
  return list;
}
