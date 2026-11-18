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
 *   @机器人 开始 项目名 任务描述 / 开始 4 / 状态 4 / 继续 4 / 取消 4 / 帮助
 */
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import type { FeedbackAction, FeedbackChannel, UiLanguage } from '@agentdesk/core';
import { commandLanguage } from './dingtalk-language.js';
import type { DingTalkStreamConfig } from './config.js';

const GATEWAY_URL = 'https://api.dingtalk.com/v1.0/gateway/connections/open';
const TOPIC_ROBOT = '/v1.0/im/bot/messages/get';
const HEARTBEAT_MS = 8_000;
type StreamFrame = { type: string; headers: Record<string, string>; data: unknown };

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
  const activity = s.match(/^(?:activity|最近活动)(?:\s*#?(\d+))?$/i);
  if (activity) {
    if (!activity[1]) return { type: 'activity' };
    const id = taskId(activity[1]);
    return id ? { type: 'activity', taskId: id } : { type: 'help' };
  }
  if (/^(projects|项目|项目列表)$/i.test(s)) return { type: 'projects' };
  if (/^(help|帮助|\?|？)$/i.test(s)) return { type: 'help' };
  const run = s.match(/^(?:start|开始|run|执行|派任务)(?:\s+|(?=【))([\s\S]+)$/i);
  if (run) {
    const prompt = run[1]!;
    const bracketed = prompt.match(/^【([^】]+)】\s*([\s\S]*)$/);
    if (bracketed) {
      const reference = bracketed[1]!.match(/^#?(\d+)$/);
      if (reference) {
        const id = taskId(reference[1]!);
        return id ? { type: 'run', taskId: id, prompt: bracketed[2] || undefined } : { type: 'help' };
      }
      return { type: 'run', projectName: bracketed[1], prompt: bracketed[2] };
    }
    const reference = prompt.match(/^#?(\d+)(?:\s+([\s\S]+))?$/);
    if (!reference) return { type: 'run', prompt };
    const id = taskId(reference[1]!);
    return id ? { type: 'run', taskId: id, prompt: reference[2] } : { type: 'help' };
  }

  const resume = s.match(/^(?:resume|continue|继续|恢复|retry|重试)\s*#?(\d+)(?=$|[\s:：,，])[\s:：,，]*([\s\S]*)$/i)
    ?? s.match(/^#?(\d+)\s*(?:resume|continue|继续|恢复|retry|重试)(?=$|[\s:：,，])[\s:：,，]*([\s\S]*)$/i);
  if (resume) {
    const id = taskId(resume[1]!);
    return id ? { type: 'resume', taskId: id, feedback: resume[2]!.trim() || undefined } : { type: 'help' };
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
  private controller?: AbortController;
  /** 钉钉 Stream 可能重投：优先按机器人消息的 msgId 去重 */
  private seenMessages = new Map<string, number>();

  constructor(
    private cfg: DingTalkStreamConfig,
    private createSocket = (url: URL) => new WebSocket(url, { handshakeTimeout: 10_000 }),
    private language = (text: string, _conversation: string, _sender: string): UiLanguage => commandLanguage(text) ?? 'zh-CN',
  ) {}

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
    if (this.controller) return;
    this.controller = new AbortController();
    const senders = new Set(Array.isArray(this.cfg.allowedSenderIds) ? this.cfg.allowedSenderIds : []);
    const conversations = new Set(Array.isArray(this.cfg.allowedConversationIds) ? this.cfg.allowedConversationIds : []);
    if (!senders.size || !conversations.size) console.warn('[dingtalk-stream] 尚未配置发送者和会话授权，群指令暂不可用');

    const onRobot = async (delivery: StreamFrame, send: (data: unknown) => void) => {
      const callbackId = typeof delivery.headers.messageId === 'string' ? delivery.headers.messageId : undefined;
      const traceId = callbackId ? createHash('sha256').update(callbackId).digest('hex').slice(0, 12) : '-';
      const ack = () => {
        if (!callbackId) {
          console.warn('[dingtalk-stream] 回调缺少 messageId，无法发送 ACK');
          return;
        }
        try {
          send({ code: 200, headers: { contentType: 'application/json', messageId: callbackId },
            message: 'OK', data: JSON.stringify({ response: {} }) });
          console.log(`[dingtalk-stream] 已发 ACK (delivery=${traceId})`);
        } catch (error) {
          console.error(`[dingtalk-stream] ACK 发送失败 (delivery=${traceId}):`, error);
        }
      };
      try {
        const msg = (typeof delivery.data === 'string' ? JSON.parse(delivery.data) : delivery.data) as IncomingMessage;
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
          await this.reply(msg.sessionWebhook, commandLanguage(content) === 'en'
            ? 'This account or conversation is not authorized. Configure access on the agentdesk host.'
            : '此钉钉账号或会话尚未授权，请在 agentdesk 宿主机完成配置。');
          return;
        }
        const action = parseCommand(content);
        action.language = this.language(content, conversation, sender);
        console.log(`📥 [dingtalk-stream] 收到指令 (delivery=${traceId} action=${action.type})`);
        const result = await dispatch(action);
        ack();
        await this.reply(msg.sessionWebhook, `${result.ok ? '' : '❌ '}${result.message}`);
      } catch (e: any) {
        console.error('[dingtalk-stream] 处理消息失败:', e?.message ?? e);
      }
    };
    void this.watchConnection(this.controller.signal, onRobot).catch(() => {
      console.error('[dingtalk-stream] 连接监控异常退出');
    });
  }

  private async watchConnection(signal: AbortSignal, onRobot: (frame: StreamFrame, send: (data: unknown) => void) => void): Promise<void> {
    let retry = 1_000;
    while (!signal.aborted) {
      try {
        await this.connectOnce(signal, onRobot, () => { retry = 1_000; });
      } catch {
        if (!signal.aborted) console.warn('[dingtalk-stream] 连接失败，稍后重试');
      }
      if (signal.aborted) break;
      await delay(retry, undefined, { signal }).catch(() => undefined);
      retry = Math.min(retry * 2, 30_000);
    }
  }

  private async connectOnce(
    signal: AbortSignal,
    onRobot: (frame: StreamFrame, send: (data: unknown) => void) => void,
    onOpen: () => void,
  ): Promise<void> {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: this.cfg.clientId, clientSecret: this.cfg.clientSecret, ua: '',
        subscriptions: [{ type: 'CALLBACK', topic: TOPIC_ROBOT }] }),
    });
    if (!res.ok) throw new Error(`Gateway HTTP ${res.status}`);
    const { endpoint, ticket } = await res.json() as { endpoint?: string; ticket?: string };
    if (!endpoint || !ticket) throw new Error('钉钉网关未返回连接信息');
    const url = new URL(endpoint);
    if (url.protocol !== 'wss:') throw new Error('钉钉网关返回的地址不是 WSS');
    url.searchParams.set('ticket', ticket);
    signal.throwIfAborted();

    await new Promise<void>(resolve => {
      const socket = this.createSocket(url);
      let heartbeat: NodeJS.Timeout | undefined;
      let alive = true;
      const abort = () => socket.terminate();
      const send = (data: unknown) => {
        if (socket.readyState !== WebSocket.OPEN) throw new Error('钉钉连接已关闭');
        socket.send(JSON.stringify(data), error => {
          if (error && !signal.aborted) console.warn('[dingtalk-stream] Stream 响应发送失败');
        });
      };
      socket.on('error', () => {
        if (!signal.aborted) console.warn('[dingtalk-stream] WebSocket 连接异常');
        socket.terminate();
      });
      socket.once('close', code => {
        clearInterval(heartbeat);
        signal.removeEventListener('abort', abort);
        if (!signal.aborted) console.warn(`[dingtalk-stream] 连接已断开，准备重连 (code=${code})`);
        resolve();
      });
      socket.once('open', () => {
        onOpen();
        console.log('📲 钉钉 Stream 反馈通道已连接（群里 @机器人 发指令）');
        heartbeat = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (!alive) {
            console.warn('[dingtalk-stream] 心跳超时，重建连接');
            socket.terminate();
            return;
          }
          alive = false;
          socket.ping();
        }, HEARTBEAT_MS);
      });
      socket.on('pong', () => { alive = true; });
      socket.on('message', data => {
        try {
          const frame = JSON.parse(data.toString()) as StreamFrame;
          if (frame.type === 'CALLBACK' && frame.headers?.topic === TOPIC_ROBOT) onRobot(frame, send);
          if (frame.type === 'SYSTEM') {
            const topic = frame.headers?.topic;
            if (topic === 'ping') send({ code: 200, headers: frame.headers, message: 'OK', data: frame.data });
            if (topic === 'KEEPALIVE') alive = true;
            if (topic === 'disconnect') socket.terminate();
          }
        } catch {
          console.warn('[dingtalk-stream] 收到无效帧');
        }
      });
      signal.addEventListener('abort', abort, { once: true });
    });
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
        signal: AbortSignal.timeout(10_000),
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
    this.controller?.abort();
    this.controller = undefined;
  }
}
