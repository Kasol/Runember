/**
 * Codex CLI 适配器 —— 事件目录来自 M0 探针实测（codex-cli 0.167.0）：
 *   thread.started (thread_id) / turn.started / item.started / item.completed
 *   item 子类型：agent_message / command_execution / file_change / turn.completed
 */
import { stripAgentctlLines, type AgentActivity, type AgentAdapter, type AdapterEvent, type ExecutionMode } from '@agentdesk/core';

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  changes?: unknown[];
  tool?: string;
  status?: string;
  exit_code?: number;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly finalResponseSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      answer: {
        type: 'string',
        description: 'User-facing answer with the requested formatting and any useful progress. If a required question is present, keep the question in input_request. The answer may be empty when only a question is needed.',
      },
      input_request: {
        type: ['string', 'null'],
        description: 'The specific question to ask the requester if continuing requires them to provide information, choose, or explicitly authorize an action. Ask in the user’s language. Use null for an outcome report, an optional suggestion, a rhetorical question, or a question requested as content.',
      },
    },
    required: ['answer', 'input_request'],
  };

  constructor(
    /** 镜像与卷名由 daemon 从分层配置注入（用户可覆盖） */
    public image: string,
    public homeVolume: string,
  ) {}

  buildArgs(prompt: string, execution?: ExecutionMode, schemaPath?: string, model?: string, reasoningEffort?: string): string[] {
    const sandbox = execution === 'capability' ? 'danger-full-access' : 'workspace-write';
    return ['codex', 'exec', '--json', '--sandbox', sandbox,
      ...(model ? ['--model', model] : []),
      ...(reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`] : []),
      ...(schemaPath ? ['--output-schema', schemaPath] : []), '--', prompt];
  }

  buildResumeArgs(sessionId: string, feedback: string, execution?: ExecutionMode, schemaPath?: string, model?: string, reasoningEffort?: string): string[] {
    const sandbox = execution === 'capability' ? 'danger-full-access' : 'workspace-write';
    return ['codex', 'exec', '--sandbox', sandbox, 'resume', sessionId, '--json',
      ...(model ? ['--model', model] : []),
      ...(reasoningEffort ? ['-c', `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`] : []),
      ...(schemaPath ? ['--output-schema', schemaPath] : []), '--', feedback];
  }

  authCheckArgs(): string[] {
    return ['/bin/sh', '-c', 'test -f /codex-home/auth.json'];
  }

  parseLine(line: string, structuredResponse = false): AdapterEvent | null {
    if (!line.startsWith('{')) return null;
    try {
      const o = JSON.parse(line) as any;
      const msg = o?.msg ?? o;
      switch (msg?.type) {
        case 'thread.started':
          return { type: 'session', sessionId: typeof msg.thread_id === 'string' ? msg.thread_id : undefined };
        case 'turn.started':
          return { type: 'activity', activity: { key: 'turn', kind: 'turn', phase: 'started' } };
        case 'item.started':
        case 'item.completed': {
          const item = msg.item as CodexItem | undefined;
          if (!item) return null;
          const started = msg.type === 'item.started';
          if (!started && item.type === 'agent_message' && typeof item.text === 'string') {
            const final = structuredResponse ? parseFinalResponse(item.text) : undefined;
            if (final) return final;
            const activity = summarizeItem(item, started);
            return { type: 'agent_message', text: item.text, ...(activity && { activity }) };
          }
          const activity = summarizeItem(item, started);
          return activity ? { type: 'activity', activity } : null;
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

function parseFinalResponse(text: string): AdapterEvent | undefined {
  try {
    const response = JSON.parse(text) as { answer?: unknown; input_request?: unknown } | null;
    if (response && typeof response.answer === 'string'
        && (response.input_request === null || typeof response.input_request === 'string')) {
      return { type: 'agent_message', text: response.answer, inputRequest: response.input_request?.trim() || undefined };
    }
  } catch { /* 中间消息和旧回复仍可作为纯文本读取 */ }
}

function summarizeItem(item: CodexItem, started: boolean): AgentActivity | undefined {
  if (typeof item.id !== 'string' || !item.id) return;
  const key = item.id;
  const phase = started ? 'started'
    : item.status === 'failed' || (typeof item.exit_code === 'number' && item.exit_code !== 0) ? 'failed' : 'completed';
  switch (item.type) {
    case 'command_execution':
      return { key, kind: 'command', phase, detail: commandLabel(item.command) };
    case 'file_change':
      return { key, kind: 'files', phase, detail: Array.isArray(item.changes) && item.changes.length ? `${item.changes.length} 项` : undefined };
    case 'mcp_tool_call':
      return { key, kind: 'tool', phase, detail: typeof item.tool === 'string' && /^[\w.-]{1,64}$/.test(item.tool) ? item.tool : undefined };
    case 'web_search':
      return { key, kind: 'search', phase };
    case 'agent_message': {
      const text = !started && typeof item.text === 'string' ? stripAgentctlLines(item.text).replace(/\s+/g, ' ').trim() : '';
      if (text) return { key, kind: 'message', phase, detail: text.length > 160 ? text.slice(0, 160) + '…' : text };
      return;
    }
  }
}

/** Only expose known executable names and verbs, never the command arguments. */
function commandLabel(command: unknown): string | undefined {
  if (typeof command !== 'string') return;
  let script = command.trim();
  if (/^(?:["']?[^"'\r\n]*[\\/])?(?:powershell|pwsh|bash|sh)(?:\.exe)?["']?\s/i.test(script)) {
    script = script.replace(/^[^\r\n]*?\s-(?:command|lc|c)\s+["']?/i, '');
  }
  const match = script.match(/^(git|gh|npm|pnpm|yarn|bun|dotnet|cargo|go|pytest|python|node|rg|Get-Content|Get-ChildItem|Get-Item)(?:\.exe)?(?=$|\s|["'])(?:\s+([\w-]+))?/i);
  if (!match) return;
  const commandName = match[1]!;
  const verb = match[2]?.toLowerCase();
  if (commandName.toLowerCase() === 'git' && verb && /^(status|diff|log|show|fetch|pull|push|rebase|merge|checkout|branch|add|commit)$/.test(verb)) {
    return `git ${verb}`;
  }
  if (/^(npm|pnpm|yarn|bun)$/i.test(commandName) && verb && /^(test|run|install|build|lint)$/.test(verb)) {
    return `${commandName} ${verb}`;
  }
  return commandName;
}
