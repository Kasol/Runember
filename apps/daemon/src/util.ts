/** 杂项：agent 注册表与配置的粘合（daemon 内唯一允许触碰 adapters 注册表的地方） */
import { getAdapter } from '@agentdesk/adapters';
import type { AgentAdapter } from '@agentdesk/core';
import type { AppConfig } from './config.js';

export function getAdapterId(agentId: string, cfg: AppConfig): AgentAdapter {
  const ac = cfg.agents[agentId];
  if (!ac) throw new Error(`agent "${agentId}" 未在配置中声明（cfg.agents）`);
  return getAdapter(agentId, ac.image, ac.codexHomeVolume);
}
