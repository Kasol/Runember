/**
 * 钉钉自定义机器人（webhook+加签）Notifier —— 通知腿的独立实现。
 * M3.5 起推荐改用应用机器人（dingtalk-app.ts）单机器人双职责；
 * 本实现保留为可选渠道（不想建企业内部应用、只需出站通知的极简场景）。
 * 消息模板与所有钉钉渠道共享：dingtalk-markdown.ts。
 */
import { createHmac } from 'node:crypto';
import type { NotifyEvent } from '@agentdesk/core';
import { DedupedNotifier } from './notify-base.js';
import { buildEventMarkdown } from './dingtalk-markdown.js';

export class DingTalkNotifier extends DedupedNotifier {
  readonly name = 'dingtalk';

  constructor(
    private ch: { access_token: string; secret?: string; events?: string[]; atAll?: boolean },
    private publicUrl: string,
  ) {
    super(30 * 60 * 1000);
  }

  /** 直接发原始 markdown（notify-test 用，绕过去重与事件过滤） */
  async sendRaw(title: string, markdown: string): Promise<void> {
    await this.post(title, markdown);
  }

  private async post(title: string, markdown: string): Promise<void> {
    let url = `https://oapi.dingtalk.com/robot/send?access_token=${this.ch.access_token}`;
    if (this.ch.secret) {
      const ts = Date.now();
      const sign = encodeURIComponent(
        createHmac('sha256', this.ch.secret).update(`${ts}\n${this.ch.secret}`).digest('base64'),
      );
      url += `&timestamp=${ts}&sign=${sign}`;
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title, text: markdown },
        at: { isAtAll: !!this.ch.atAll },
      }),
    });
    const data = await res.json() as { errcode: number; errmsg: string };
    if (data.errcode !== 0) throw new Error(`钉钉返回 ${data.errcode}: ${data.errmsg}`);
  }

  protected async send(e: NotifyEvent): Promise<void> {
    const want = this.ch.events ?? ['blocked', 'failed'];
    if (!want.includes(e.kind.replace('run.', ''))) return;
    const md = buildEventMarkdown(e, this.publicUrl);
    if (md) await this.post(md.title, md.text);
  }
}
