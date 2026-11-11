/**
 * 钉钉 Stream 反馈通道（M3+）—— 真正的"手机闭环"。
 *
 * 拓扑：daemon --出站 WSS 长连--> 钉钉开放平台 --> 群里 @机器人 的消息推给 daemon
 *       daemon 解析指令 --> applyTaskAction --> 结果经 sessionWebhook 回到群里
 * 全程零公网暴露、零内网穿透（与 Notifier 的 webhook 出站互补成环）。
 *
 * 前置（用户一次性操作，见 README）：
 *   dev.dingtalk.com 创建企业内部应用 → 拿 ClientID/AppKey + ClientSecret
 *   → 应用能力添加"机器人"，消息接收模式选 Stream → 机器人拉进群
 * 配置（~/.agentdesk/config.json）：
 *   "feedback": { "dingtalkStream": { "clientId": "...", "clientSecret": "..." } }
 *
 * 群内指令语法（中英等价）：
 *   @机器人 resume 4 可以合并，今晚不部署
 *   @机器人 retry 4 / cancel 4 / status / 帮助
 */
import { DWClient, EventAck, TOPIC_ROBOT } from 'dingtalk-stream-sdk-nodejs';
import type { FeedbackAction, FeedbackChannel } from '@agentdesk/core';
import { learn } from './dingtalk-state.js';

interface IncomingMessage {
  text?: { content?: string };
  senderNick?: string;
  sessionWebhook?: string;
  conversationId?: string;
  robotCode?: string;
}

function parseCommand(raw: string): FeedbackAction {
  const s = raw.trim().replace(/^@\S+\s*/, '');
  if (/^(status|状态|队列)$/i.test(s)) return { type: 'status' };
  if (/^(help|帮助|\?|？)$/i.test(s)) return { type: 'help' };

  // resume 可省编号：单阻塞任务时自动指向它（applyTaskAction 内解析歧义）
  let m = s.match(/^(?:resume|继续|恢复)\s*(?:#?(\d+))?\s*[:：,，]?\s*([\s\S]*)$/i);
  if (m) return { type: 'resume', taskId: m[1] ? Number(m[1]) : undefined, feedback: m[2]!.trim() || '请继续' };
  m = s.match(/^(?:retry|重试)\s*#?(\d+)\s*$/i);
  if (m) return { type: 'retry', taskId: Number(m[1]) };
  m = s.match(/^(?:cancel|取消|终止)\s*#?(\d+)\s*$/i);
  if (m) return { type: 'cancel', taskId: Number(m[1]) };
  return { type: 'help' };
}

export class DingTalkStreamChannel implements FeedbackChannel {
  readonly name = 'dingtalk-stream';
  private client?: DWClient;
  /** 钉钉 Stream 是 at-least-once 投递：按 messageId 幂等去重 */
  private seenMessages = new Map<string, number>();

  constructor(private cfg: { clientId: string; clientSecret: string }) {}

  private isDuplicate(messageId: string | undefined): boolean {
    if (!messageId) return false;
    // 顺带清理 10 分钟前的旧 id，防集合无限增长
    const now = Date.now();
    for (const [k, t] of this.seenMessages) if (now - t > 600_000) this.seenMessages.delete(k);
    if (this.seenMessages.has(messageId)) return true;
    this.seenMessages.set(messageId, now);
    return false;
  }

  async start(
    dispatch: (a: FeedbackAction) => Promise<{ ok: boolean; message: string }>,
  ): Promise<void> {
    const client = new DWClient({
      clientId: this.cfg.clientId,
      clientSecret: this.cfg.clientSecret,
    });

    client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
      try {
        const msg: IncomingMessage = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
        const content = msg.text?.content ?? '';
        // 学习群标识（应用机器人主动推送 groupMessages/send 需要它）
        if (msg.conversationId) learn({ conversationId: msg.conversationId, robotCode: msg.robotCode });
        // at-least-once 幂等：钉钉重推同一消息时只处理一次
        if (this.isDuplicate((res as any)?.headers?.messageId)) return { status: EventAck.SUCCESS };
        if (!content.trim()) return { status: EventAck.SUCCESS };
        console.log(`📥 [dingtalk-stream] ${msg.senderNick ?? '?'}: ${content.slice(0, 60)}`);

        const action = parseCommand(content);
        const result = await dispatch(action);
        await this.reply(msg.sessionWebhook, `${result.ok ? '' : '❌ '}${result.message}`);
        return { status: EventAck.SUCCESS };
      } catch (e: any) {
        console.error('[dingtalk-stream] 处理消息失败:', e?.message ?? e);
        return { status: EventAck.SUCCESS };
      }
    });

    await client.connect();
    this.client = client;
    console.log('📲 钉钉 Stream 反馈通道已连接（群里 @机器人 发指令）');
  }

  /** 通过消息自带的 sessionWebhook 回复（临时口，无需 accessToken） */
  private async reply(sessionWebhook: string | undefined, text: string): Promise<void> {
    if (!sessionWebhook) return;
    try {
      await fetch(sessionWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { title: 'agentdesk', text } }),
      });
    } catch (e: any) {
      console.error('[dingtalk-stream] 回复失败:', e?.message ?? e);
    }
  }

  stop(): void {
    try { this.client?.disconnect?.(); } catch { /* noop */ }
  }
}
