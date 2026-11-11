/**
 * 钉钉自定义机器人 Notifier（M3）。
 * 接入方式：群 → 设置 → 机器人 → 添加"自定义"机器人 → 安全设置选"加签"。
 * 纯出站 HTTPS（国内直连，无需代理），符合"零入站"的部署哲学。
 *
 * 配置示例（~/.agentdesk/config.json）：
 *   "notify": { "channels": [{
 *     "type": "dingtalk-webhook",
 *     "access_token": "xxx",
 *     "secret": "SECxxx",
 *     "events": ["blocked", "failed"]        // 可加 "succeeded"
 *   }]}
 */
import { createHmac } from 'node:crypto';
import type { NotifyEvent } from '@agentdesk/core';
import { DedupedNotifier } from './notify-base.js';

export class DingTalkNotifier extends DedupedNotifier {
  readonly name = 'dingtalk';

  constructor(
    private ch: { access_token: string; secret?: string; events?: string[]; atAll?: boolean },
    private publicUrl: string,
  ) {
    super(30 * 60 * 1000); // 同任务同类事件 30 分钟去重（防骚扰基类）
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
    const t = `**任务#${e.task.id}** · 项目 \`${e.project.name}\``;

    if (e.kind === 'run.blocked') {
      const md = [
        '### ⚠️ agentdesk 任务阻塞',
        '',
        `${t} · \`${e.blockedKind}\``,
        '',
        e.question ? `> ${e.question}` : '> （详见任务日志）',
        '',
        '**反馈继续：**',
        '',
        '```bash',
        `npm run desk -- resume ${e.task.id} "你的决定"`,
        '```',
        this.publicUrl ? `\n[打开任务详情](${this.publicUrl}/tasks/${e.task.id})` : '',
      ].join('\n');
      await this.post('⚠️ agentdesk 任务阻塞', md);
      return;
    }

    if (e.kind === 'run.failed') {
      const md = [
        '### ❌ agentdesk 任务失败',
        '',
        `${t}`,
        '',
        `> ${e.reason.slice(0, 200)}`,
        '',
        '```bash',
        `npm run desk -- retry ${e.task.id}`,
        '```',
      ].join('\n');
      await this.post('❌ agentdesk 任务失败', md);
      return;
    }

    if (e.kind === 'run.succeeded') {
      const md = [
        '### ✅ agentdesk 任务完成',
        '',
        `${t}`,
        '',
        e.summary.agentMessage ? `> ${e.summary.agentMessage.replace(/\n/g, ' ').slice(0, 200)}` : '',
        '',
        e.summary.filesChanged.length
          ? `📝 改动 ${e.summary.filesChanged.length} 个文件`
          : '📝 无文件改动',
      ].join('\n');
      await this.post('✅ agentdesk 任务完成', md);
      return;
    }

    // run.started（默认不订阅，配置了才到这）
    await this.post('▶️ agentdesk 任务开始', `### ▶️ 任务开始\n\n${t}`);
  }
}
