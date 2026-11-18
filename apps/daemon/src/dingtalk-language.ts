import { createHash } from 'node:crypto';
import type { LanguagePreference, UiLanguage } from '@agentdesk/core';
import type { Store } from './store.js';

export function commandLanguage(raw: string): UiLanguage | undefined {
  const command = raw.trim().replace(/^@\S+\s*/, '').replace(/^#?\d+\s*/, '');
  if (/^(?:项目|开始|执行|派任务|状态|队列|详情|明细|列表|最近活动|继续|恢复|重试|取消|帮助|草稿)/.test(command)) return 'zh-CN';
  if (/^(?:projects|start|run|status|detail|activity|resume|continue|retry|cancel|help|draft)(?=$|\s|#|\d)/i.test(command)) return 'en';
}

/** The robot callback has no documented client-language field. */
export class DingTalkLanguage {
  constructor(private store: Store) {}

  preference(): LanguagePreference {
    const value = this.store.getSetting('dingtalk.language');
    return value === 'en' || value === 'zh-CN' ? value : 'auto';
  }

  private key(conversation?: string, sender?: string): string {
    return 'dingtalk.detectedLanguage.' + createHash('sha256').update(JSON.stringify([conversation, sender])).digest('hex');
  }

  notification = (conversation?: string): UiLanguage => {
    const fixed = this.preference();
    if (fixed !== 'auto') return fixed;
    return this.store.getSetting(this.key(conversation)) === 'en' ? 'en' : 'zh-CN';
  };

  resolve = (text: string, conversation: string, sender: string): UiLanguage => {
    const fixed = this.preference();
    if (fixed !== 'auto') return fixed;
    const detected = commandLanguage(text);
    if (detected) {
      for (const key of [this.key(conversation), this.key(conversation, sender)]) {
        if (this.store.getSetting(key) !== detected) this.store.setSetting(key, detected);
      }
      return detected;
    }
    const previous = this.store.getSetting(this.key(conversation, sender));
    return previous === 'en' || previous === 'zh-CN' ? previous : this.notification(conversation);
  };
}
