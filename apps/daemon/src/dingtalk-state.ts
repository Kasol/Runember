/** 应用机器人学习到的群标识（openConversationId / robotCode），供主动推送用；重启持久化 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let file: string | null = null;
let state: { conversationId?: string; robotCode?: string } = {};

export function initState(dataDir: string): void {
  file = join(dataDir, 'dingtalk-state.json');
  if (existsSync(file)) {
    try { state = JSON.parse(readFileSync(file, 'utf8')); } catch { /* 损坏则重学 */ }
  }
}

export function learned(): { conversationId?: string; robotCode?: string } {
  return { ...state };
}

export function learn(patch: { conversationId?: string; robotCode?: string }): void {
  state = { ...state, ...patch };
  if (file) { try { writeFileSync(file, JSON.stringify(state)); } catch { /* 尽力持久化 */ } }
}
