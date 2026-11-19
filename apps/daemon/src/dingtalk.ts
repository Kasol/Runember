/**
 * 钉钉自定义机器人（webhook+加签）Notifier —— 通知腿的独立实现。
 * M3.5 起推荐改用应用机器人（dingtalk-app.ts）单机器人双职责；
 * 本实现保留为可选渠道（不想建企业内部应用、只需出站通知的极简场景）。
 * 消息模板与所有钉钉渠道共享：dingtalk-markdown.ts。
 */
import { createHmac } from 'node:crypto';
import type { NotifyEvent, UiLanguage } from '@agentdesk/core';
import { DedupedNotifier } from './notify-base.js';
import { buildEventMarkdown, detailFooter, reportReadyMarkdown } from './dingtalk-markdown.js';
import type { ReportLink } from './dingtalk-reports.js';
import { ReportDelivery, type DeliveryStorage } from './report-delivery.js';

export class DingTalkNotifier extends DedupedNotifier {
  readonly name = 'dingtalk';
  private delivery?: ReportDelivery;

  constructor(
    private ch: { access_token: string; secret?: string; events?: string[]; atAll?: boolean },
    private publicUrl: string,
    private reportLink?: ReportLink,
    private language: () => UiLanguage = () => 'zh-CN',
    storage?: DeliveryStorage,
  ) {
    super(30 * 60 * 1000);
    if (reportLink) this.delivery = new ReportDelivery({ storage, identity: ['dingtalk-webhook', ch.access_token], publish: reportLink,
      accept: event => (this.ch.events ?? ['blocked', 'failed']).includes(event.kind.replace('run.', '')),
      result: (event, lang, url, failed) => this.sendResult(event, lang, url, failed),
      link: async (event, lang, url) => {
        const md = reportReadyMarkdown(event, lang); await this.post(md.title, md.text, url, lang);
        console.log(`[notify:dingtalk-webhook] 钉钉已接受报告链接 task=${event.task.id} run=${event.runId}`);
      },
    });
  }
  start(): void { this.delivery?.start(); }
  stop(): void { this.delivery?.stop(); }
  async drain(): Promise<void> { await this.delivery?.drain(); }
  retryReport(runId: number): number { return this.delivery?.retry(runId) ?? 0; }

  /** 直接发原始 markdown（notify-test 用，绕过去重与事件过滤） */
  async sendRaw(title: string, markdown: string): Promise<void> {
    await this.post(title, markdown);
  }

  private async post(title: string, markdown: string, detailUrl?: string, language = this.language()): Promise<void> {
    let url = `https://oapi.dingtalk.com/robot/send?access_token=${this.ch.access_token}`;
    if (this.ch.secret) {
      const ts = Date.now();
      const sign = encodeURIComponent(
        createHmac('sha256', this.ch.secret).update(`${ts}\n${this.ch.secret}`).digest('base64'),
      );
      url += `&timestamp=${ts}&sign=${sign}`;
    }
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown', markdown: { title, text: detailFooter(markdown, detailUrl, language) },
        at: { isAtAll: !!this.ch.atAll },
      }),
    });
    const data = await res.json() as { errcode: number; errmsg: string };
    if (data.errcode !== 0) throw new Error(`钉钉返回 ${data.errcode}: ${data.errmsg}`);
  }

  protected async send(e: NotifyEvent): Promise<void> {
    const want = this.ch.events ?? ['blocked', 'failed'];
    const connection = e.kind === 'run.connection_warning' || e.kind === 'run.connection_recovered';
    if (!want.includes(connection ? 'failed' : e.kind.replace('run.', ''))) return;
    const language = this.language();
    if (this.delivery && !connection && e.kind !== 'run.started') return this.delivery.deliver(e, language);
    await this.sendResult(e, language);
  }
  private async sendResult(e: NotifyEvent, language: UiLanguage, reportUrl?: string, reportFailed = false): Promise<void> {
    const md = buildEventMarkdown(e, this.publicUrl, reportUrl, language, reportFailed);
    if (md) await this.post(md.title, md.text, md.detailUrl, language);
  }
}
