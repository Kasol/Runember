/**
 * 应用机器人主动推送腿（M3.5 合并方案）：
 * 用企业内部应用的 ClientID/Secret 换 accessToken，经 groupMessages/send 主动推群。
 * 目标群的 openConversationId/robotCode 由 Stream 通道从第一条 @消息 自动学习（dingtalk-state）。
 * 与 webhook 机器人功能等价 —— 配置了应用机器人后可删除 webhook 机器人，单机器人双职责。
 */
import type { NotifyEvent } from '@agentdesk/core';
import { DedupedNotifier } from './notify-base.js';
import { buildEventMarkdown } from './dingtalk-markdown.js';
import { learned } from './dingtalk-state.js';

export class DingTalkAppNotifier extends DedupedNotifier {
  readonly name = 'dingtalk-app';
  private token?: { v: string; exp: number };

  constructor(
    private clientId: string,
    private clientSecret: string,
    private publicUrl: string,
    private events: string[] = ['blocked', 'failed', 'succeeded'],
  ) {
    super(30 * 60 * 1000);
  }

  async sendRaw(title: string, text: string): Promise<void> {
    await this.post(title, text);
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.exp - 60_000) return this.token.v;
    const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appKey: this.clientId, appSecret: this.clientSecret }),
    });
    const d = await res.json() as { accessToken?: string; expireIn?: number; message?: string };
    if (!d.accessToken) throw new Error(`获取 accessToken 失败: ${d.message ?? JSON.stringify(d)}`);
    this.token = { v: d.accessToken, exp: Date.now() + (d.expireIn ?? 7200) * 1000 };
    return d.accessToken;
  }

  private async post(title: string, markdown: string): Promise<void> {
    const { conversationId, robotCode } = learned();
    if (!conversationId) {
      console.warn('[notify:dingtalk-app] 尚未学习群标识（在群里 @机器人 发一条消息即激活主动推送），本次跳过');
      return;
    }
    const token = await this.getToken();
    const res = await fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({
        msgKey: 'sampleMarkdown',
        msgParam: JSON.stringify({ title, text: markdown }),
        openConversationId: conversationId,
        robotCode: robotCode || this.clientId,
      }),
    });
    const d = await res.json() as { code?: string; message?: string; processQueryKey?: string };
    if (!res.ok || d.code) throw new Error(`钉钉群发 ${d.code ?? res.status}: ${d.message ?? ''}`);
  }

  protected async send(e: NotifyEvent): Promise<void> {
    if (!this.events.includes(e.kind.replace('run.', ''))) return;
    const md = buildEventMarkdown(e, this.publicUrl);
    if (md) await this.post(md.title, md.text);
  }
}
