import type { AgentAdapter, AdapterEvent } from '@agentdesk/core';

/** ZCode Protocol events, shared by the headless CLI and app-server. */
export class ZcodeAdapter implements AgentAdapter {
  readonly id = 'zcode';
  constructor(public image = '', public homeVolume = '') {}
  buildArgs(prompt: string): string[] {
    return ['zcode', '--prompt', prompt, '--output-format', 'stream-json', '--mode', 'yolo'];
  }
  buildResumeArgs(sessionId: string, feedback: string): string[] {
    return [...this.buildArgs(feedback), '--resume', sessionId];
  }
  authCheckArgs(): string[] { return ['zcode', '--version']; }
  parseLine(line: string): AdapterEvent | null {
    try {
      const frame = JSON.parse(line);
      const event = frame.method === 'session/event' ? frame.params?.event ?? frame.params : frame;
      const p = event.payload ?? {};
      const sessionId = typeof event.sessionId === 'string' ? event.sessionId : undefined;
      const selection = p.intent?.modelSelection ?? (p.providerId && p.modelId ? p : undefined);
      const model = selection ? `${selection.providerId}/${selection.modelId}` : undefined;
      const base = { sessionId, ...(model && { model }) };
      if (event.type === 'turn.started') return { ...base, type: 'activity', activity: { key: event.turnId ?? 'turn', kind: 'turn', phase: 'started' } };
      if (event.type === 'turn.completed' || event.type === 'result') return {
        ...base, type: 'agent_message', text: typeof (p.response ?? event.response) === 'string' ? p.response ?? event.response : '',
      };
      if (event.type === 'turn.failed') return { ...base, type: 'error', text: p.error?.message ?? p.message ?? 'ZCode turn failed' };
      if (event.type === 'userInput.requested') return { ...base, type: 'input_requested', text: p.prompt };
      if (event.type === 'permission.requested') {
        const questions = Array.isArray(p.input?.questions) ? p.input.questions.map((question: any) => {
          const options = Array.isArray(question.options) ? question.options.map((option: any) => typeof option === 'string' ? option : option.label).filter(Boolean) : [];
          return typeof question.question === 'string' ? question.question + (options.length ? '\n' + options.map((option: string) => `- ${option}`).join('\n') : '') : '';
        }).filter(Boolean).join('\n\n') : '';
        return { ...base, type: 'input_requested', text: questions || p.reason || p.message || `需要授权工具 ${p.toolName ?? ''}` };
      }
      if (event.type === 'tool.updated') {
        const tool = p.tool ?? p;
        const key = tool.toolCallId ?? tool.id ?? p.toolCallId;
        if (typeof key !== 'string') return null;
        return { ...base, type: 'activity', activity: {
          key, kind: 'tool', phase: ['error', 'failed', 'denied'].includes(tool.status ?? tool.kind) || tool.result?.isError ? 'failed'
            : ['completed', 'success', 'succeeded', 'result'].includes(tool.status ?? tool.kind) ? 'completed' : 'started',
          detail: typeof (tool.toolName ?? tool.name) === 'string' ? (tool.toolName ?? tool.name).replace(/[^\w.-]/g, '').slice(0, 64) : undefined,
        } };
      }
      return sessionId || model ? { ...base, type: 'other' } : null;
    } catch { return null; }
  }
}
