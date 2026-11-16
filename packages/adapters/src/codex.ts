/**
 * Codex CLI 适配器 —— 事件目录来自 M0 探针实测（codex-cli 0.167.0）：
 *   thread.started (thread_id) / turn.started / item.started / item.completed
 *   item 子类型：agent_message / command_execution / file_change / turn.completed
 */
import { AgentAdapter, AdapterEvent, AGENTCTL_CONTRACT } from '@agentdesk/core';

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';

  constructor(
    /** 镜像与卷名由 daemon 从分层配置注入（用户可覆盖） */
    public image: string,
    public homeVolume: string,
  ) {}

  buildArgs(prompt: string): string[] {
    return ['codex', 'exec', '--json', '--sandbox', 'workspace-write', prompt + AGENTCTL_CONTRACT];
  }

  buildResumeArgs(sessionId: string, feedback: string): string[] {
    return ['codex', 'exec', 'resume', sessionId, '--json', '--sandbox', 'workspace-write', feedback];
  }

  authCheckArgs(): string[] {
    return ['/bin/sh', '-c', 'test -f /codex-home/auth.json'];
  }

  parseLine(line: string): AdapterEvent | null {
    if (!line.startsWith('{')) return null;
    try {
      const o = JSON.parse(line) as any;
      const msg = o?.msg ?? o;
      switch (msg?.type) {
        case 'thread.started':
          return { type: 'session', sessionId: typeof msg.thread_id === 'string' ? msg.thread_id : undefined };
        case 'item.completed': {
          const item = msg.item;
          if (item?.type === 'agent_message' && typeof item.text === 'string') {
            return { type: 'agent_message', text: item.text };
          }
          return null;
        }
        case 'turn.aborted':
        case 'error':
          return { type: 'error', text: JSON.stringify(msg).slice(0, 500) };
        default:
          return null;
      }
    } catch {
      return null;
    }
  }
}
