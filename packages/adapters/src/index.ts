/**
 * Agent 注册表 —— daemon 全程只认这里，业务代码不出现任何具体 Agent 名。
 * 新增 Agent = 新增实现文件 + 在这里注册一行。
 */
import { AgentAdapter } from '@agentdesk/core';
import { CodexAdapter } from './codex.js';
import { ZcodeAdapter } from './zcode.js';
import { DeepseekAdapter } from './deepseek.js';

export type AdapterFactory = (image: string, homeVolume: string) => AgentAdapter;

const REGISTRY = new Map<string, AdapterFactory>([
  ['codex', (img, vol) => new CodexAdapter(img, vol)],
  ['zcode', (img, vol) => new ZcodeAdapter(img, vol)],
  ['deepseek', (img, vol) => new DeepseekAdapter(img, vol)],
]);

export function getAdapter(
  id: string,
  image: string,
  homeVolume: string,
): AgentAdapter {
  const factory = REGISTRY.get(id);
  if (!factory) throw new Error(`未知 agent: ${id}（已注册: ${[...REGISTRY.keys()].join(', ')}）`);
  return factory(image, homeVolume);
}

export function availableAgents(): string[] {
  return [...REGISTRY.keys()];
}

export const agentDefinitions = [
  { id: 'codex', label: 'Codex', modes: ['capability', 'isolation'] },
  { id: 'zcode', label: 'ZCode', modes: ['capability'] },
  { id: 'deepseek', label: 'DeepSeek Harness', modes: ['capability'] },
] as const;
