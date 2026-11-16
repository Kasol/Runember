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
import { createHash } from 'node:crypto';
import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import type { FeedbackAction, FeedbackChannel } from '@agentdesk/core';
import type { DingTalkStreamConfig } from './config.js';

interface IncomingMessage {
  msgId?: string;
  senderId?: string;
  senderStaffId?: string;
  text?: { content?: string };
  sessionWebhook?: string;
  conversationId?: string;
}

export function parseCommand(raw: string): FeedbackAction {
  const s = raw.trim().replace(/^@\S+\s*/, '');
  const taskId = (value: string) => {
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
  };
  const status = s.match(/^(?:status|状态|队列|detail|详情|明细|列表)(?:\s*#?(\d+))?$/i);
  if (status) {
    if (!status[1]) return { type: 'status' };
    const id = taskId(status[1]);
    return id ? { type: 'status', taskId: id } : { type: 'help' };
  }
  if (/^(projects|项目|项目列表)$/i.test(s)) return { type: 'projects' };
  if (/^(help|帮助|\?|？)$/i.test(s)) return { type: 'help' };
  if (/^(draft|草稿)\s/i.test(s)) return { type: 'draft', prompt: s.replace(/^(?:draft|草稿)\s+/i, '') };
  const run = s.match(/^(?:run|执行|派任务)\s+([\s\S]+)$/i);
  if (run) {
    const prompt = run[1]!;
    const reference = prompt.match(/^#?(\d+)(?:\s+([\s\S]+))?$/);
    if (!reference) return { type: 'run', prompt };
    const id = taskId(reference[1]!);
    return id ? { type: 'run', taskId: id, prompt: reference[2] } : { type: 'help' };
  }

  const resume = s.match(/^(?:resume|继续|恢复)\s*#?(\d+)(?=$|[\s:：,，])[\s:：,，]*([\s\S]*)$/i)
    ?? s.match(/^#?(\d+)\s*(?:resume|继续|恢复)(?=$|[\s:：,，])[\s:：,，]*([\s\S]*)$/i);
  if (resume) {
    const id = taskId(resume[1]!);
    return id ? { type: 'resume', taskId: id, feedback: resume[2]!.trim() || undefined } : { type: 'help' };
  }
  const retry = s.match(/^(?:retry|重试)\s*#?(\d+)$/i) ?? s.match(/^#?(\d+)\s*(?:retry|重试)$/i);
  if (retry) {
    const id = taskId(retry[1]!);
    return id ? { type: 'retry', taskId: id } : { type: 'help' };
  }
  const cancel = s.match(/^(?:cancel|取消)\s*#?(\d+)$/i) ?? s.match(/^#?(\d+)\s*(?:cancel|取消)$/i);
  if (cancel) {
    const id = taskId(cancel[1]!);
    return id ? { type: 'cancel', taskId: id } : { type: 'help' };
  }
  return { type: 'help' };
}

export class DingTalkStreamChannel implements FeedbackChannel {
  readonly name = 'dingtalk-stream';
  private client?: DWClient;
  /** 钉钉 Stream 可能重投：优先按机器人消息的 msgId 去重 */
  private seenMessages = new Map<string, number>();

  constructor(private cfg: DingTalkStreamConfig) {}

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
      // 僵尸连接根治：WS ping/pong 心跳（8s 一轮，pong 不回即 terminate
      // → close 事件 → SDK autoReconnect 自动重建）。默认 false，半开连接会永久僵尸。
      keepAlive: true,
    });
    client.debug = false;
    const senders = new Set(Array.isArray(this.cfg.allowedSenderIds) ? this.cfg.allowedSenderIds : []);
    const conversations = new Set(Array.isArray(this.cfg.allowedConversationIds) ? this.cfg.allowedConversationIds : []);
    if (!senders.size || !conversations.size) console.warn('[dingtalk-stream] 尚未配置发送者和会话授权，群指令暂不可用');

    client.registerCallbackListener(TOPIC_ROBOT, async (delivery) => {
      const callbackId = delivery.headers.messageId;
      const traceId = callbackId ? createHash('sha256').update(callbackId).digest('hex').slice(0, 12) : '-';
      const ack = () => {
        if (!callbackId) {
          console.warn('[dingtalk-stream] 回调缺少 messageId，无法发送 ACK');
          return;
        }
        try {
          client.socketCallBackResponse(callbackId, {});
          console.log(`[dingtalk-stream] 已发 ACK (delivery=${traceId})`);
        } catch (error) {
          console.error(`[dingtalk-stream] ACK 发送失败 (delivery=${traceId}):`, error);
        }
      };
      try {
        const msg: IncomingMessage = typeof delivery.data === 'string' ? JSON.parse(delivery.data) : delivery.data;
        const messageKey = msg.msgId ? `msg:${msg.msgId}` : callbackId ? `callback:${callbackId}` : undefined;
        if (this.isDuplicate(messageKey)) {
          console.log(`♻️ [dingtalk-stream] 重复投递已忽略 (delivery=${traceId})`);
          ack();
          return;
        }
        const sender = msg.senderStaffId || msg.senderId;
        const conversation = msg.conversationId;
        const content = msg.text?.content ?? '';
        if (!sender || !conversation || !senders.has(sender) || !conversations.has(conversation)) {
          const probe = content.trim().match(/^agentdesk-pair ([a-f0-9]{16})$/);
          if (probe && sender && conversation) {
            const challenge = createHash('sha256').update(probe[1]!).digest('hex');
            console.info('[dingtalk-stream] 本机授权核对 ' + JSON.stringify({ challenge, sender, conversation }));
          }
          console.warn(`[dingtalk-stream] 拒绝未授权指令 (delivery=${traceId})`);
          ack();
          await this.reply(msg.sessionWebhook, '此钉钉账号或会话尚未授权，请在 agentdesk 宿主机完成配置。');
          return;
        }
        const action = parseCommand(content);
        console.log(`📥 [dingtalk-stream] 收到指令 (delivery=${traceId} action=${action.type})`);
        const result = await dispatch(action);
        ack();
        await this.reply(msg.sessionWebhook, `${result.ok ? '' : '❌ '}${result.message}`);
      } catch (e: any) {
        console.error('[dingtalk-stream] 处理消息失败:', e?.message ?? e);
      }
    });

    try {
      await client.connect();
    } catch {
      throw new Error('钉钉 Stream 连接失败，请检查应用凭证和网络');
    }
    this.client = client;
    if (client.connected) console.log('📲 钉钉 Stream 反馈通道已连接（群里 @机器人 发指令）');
    else console.warn('[dingtalk-stream] 首次连接未完成，SDK 将重试');
  }

  /** 通过消息自带的 sessionWebhook 回复（临时口，无需 accessToken） */
  private async reply(sessionWebhook: string | undefined, text: string): Promise<void> {
    if (!sessionWebhook) {
      console.warn('[dingtalk-stream] 无 sessionWebhook，跳过回复');
      return;
    }
    try {
      const res = await fetch(sessionWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { title: 'agentdesk', text } }),
      });
      const body = await res.json() as { errcode?: number; errmsg?: string };
      console.log(`📤 [dingtalk-stream] 回复结果: HTTP ${res.status} errcode=${body.errcode} ${body.errmsg ?? ''}`);
    } catch (e: any) {
      console.error('[dingtalk-stream] 回复失败:', e?.message ?? e);
    }
  }

  stop(): void {
    try { this.client?.disconnect?.(); } catch { /* noop */ }
  }
}
