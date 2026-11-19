import type { AgentAdapter, AdapterEvent } from '@agentdesk/core';

/** DeepSeek Harness headless --json, verified against desktop 0.2.1-rc.5. */
export class DeepseekAdapter implements AgentAdapter {
  readonly id = 'deepseek';
  constructor(public image = '', public homeVolume = '') {}
  buildArgs(prompt: string): string[] { return ['dsh', '--profile', 'headless', '--json', '--', prompt]; }
  buildResumeArgs(sessionId: string, feedback: string): string[] {
    return ['dsh', '--profile', 'headless', '--json', '--session-id', sessionId, '--', feedback];
  }
  authCheckArgs(): string[] { return ['dsh', '--version']; }
  parseLine(line: string): AdapterEvent | null {
    try {
      const event = JSON.parse(line);
      if (event.type === 'thinking') return { type: 'other', progress: true };
      if (event.type === 'session' && typeof event.sessionId === 'string') return { type: 'session', sessionId: event.sessionId };
      if (event.type === 'final' && typeof event.text === 'string') return { type: 'agent_message', text: event.text, final: true };
      if (event.type === 'error') return { type: 'error', text: typeof event.message === 'string' ? event.message : 'DeepSeek Harness error' };
      if (event.type === 'status' && event.phase === 'turn_start') return { type: 'activity', activity: { key: `turn-${event.turn}`, kind: 'turn', phase: 'started' } };
      if (event.type === 'status' && event.phase === 'turn_end') return {
        type: event.reason?.kind === 'error' ? 'error' : 'activity',
        ...(event.reason?.kind === 'error' && { text: event.reason.error?.message ?? event.reason.error?.code ?? 'DeepSeek turn failed' }),
        activity: { key: `turn-${event.turn}`, kind: 'turn', phase: event.reason?.kind === 'error' ? 'failed' : 'completed' },
      };
      if ((event.type === 'tool_call' || event.type === 'tool_result') && typeof event.callId === 'string') return {
        type: 'activity', activity: { key: event.callId, kind: 'tool',
          phase: event.type === 'tool_call' ? 'started' : event.status === 'error' ? 'failed' : 'completed',
          detail: typeof event.tool === 'string' && /^[\w.-]{1,64}$/.test(event.tool) ? event.tool : undefined },
      };
      return null;
    } catch { return null; }
  }
}
