/**
 * 应用机器人主动推送腿（M3.5 合并方案）：
 * 用企业内部应用的 ClientID/Secret 换 accessToken，经 groupMessages/send 主动推群。
 * 主动推送使用显式配置的会话和机器人标识。
 * 与 webhook 机器人功能等价 —— 配置了应用机器人后可删除 webhook 机器人，单机器人双职责。
 */
import type { NotifyEvent, UiLanguage } from '@agentdesk/core';
import { DedupedNotifier } from './notify-base.js';
import { buildEventMarkdown, detailFooter } from './dingtalk-markdown.js';
import type { ReportLink } from './dingtalk-reports.js';

export class DingTalkAppNotifier extends DedupedNotifier {
  readonly name = 'dingtalk-app';
  private token?: { v: string; exp: number };

  constructor(
    private clientId: string,
    private clientSecret: string,
    private publicUrl: string,
    private events: string[] = ['blocked', 'failed', 'succeeded'],
    private destination: { conversationId?: string; robotCode?: string } = {},
    private reportLink?: ReportLink,
    private language: () => UiLanguage = () => 'zh-CN',
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

  private async post(title: string, markdown: string, detailUrl?: string, language = this.language()): Promise<void> {
    const { conversationId, robotCode } = this.destination;
    if (!conversationId) throw new Error('钉钉主动通知缺少 conversationId');
    const token = await this.getToken();
    const res = await fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({
        msgKey: 'sampleMarkdown',
        msgParam: JSON.stringify({ title, text: detailFooter(markdown, detailUrl, language) }),
        openConversationId: conversationId,
        robotCode: robotCode || this.clientId,
      }),
    });
    const d = await res.json() as { code?: string; message?: string; processQueryKey?: string };
    if (!res.ok || d.code) throw new Error(`钉钉群发 ${d.code ?? res.status}: ${d.message ?? ''}`);
  }

  protected async send(e: NotifyEvent): Promise<void> {
    const connection = e.kind === 'run.connection_warning' || e.kind === 'run.connection_recovered';
    if (!this.events.includes(connection ? 'failed' : e.kind.replace('run.', ''))) return;
    const language = this.language();
    let reportFailed = false;
    const reportUrl = connection ? undefined : await this.reportLink?.(e, language).catch(error => {
      console.warn(`[dingtalk-report] task=${e.task.id} run=${e.runId} ${(error as Error).message}`);
      reportFailed = true;
      return undefined;
    });
    const md = buildEventMarkdown(e, this.publicUrl, reportUrl, language, reportFailed);
    if (md) {
      await this.post(md.title, md.text, md.detailUrl, language);
      console.log(`[notify:dingtalk-app] 钉钉已接受通知 task=${e.task.id} run=${e.runId} event=${e.kind}`);
    }
  }
}
