/** 前端共享类型与 API 客户端（与 daemon REST 一一对应） */

import type { Project, Task, Run, TaskStatus } from '@agentdesk/core';
export type { Project, Task, Run } from '@agentdesk/core';

export interface MergeStatus {
  repo?: string;
  pr?: number;
  verified?: { base: string; head: string };
  completed?: string;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const tokenKey = 'agentdesk.api-token';
export function setApiToken(token: string): void { sessionStorage.setItem(tokenKey, token); }

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = sessionStorage.getItem(tokenKey);
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { 'x-agentdesk-token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const client = {
  projects: () => api<{ projects: Project[] }>('GET', '/api/projects'),
  tasks: () => api<{ tasks: Task[] }>('GET', '/api/tasks'),
  task: (id: number) => api<{ task: Task; runs: Run[]; merge?: MergeStatus }>('GET', `/api/tasks/${id}`),
  run: (id: number) => api<{ run: Run; logTail: string[] }>('GET', `/api/runs/${id}`),
  createTask: (project: string | number, prompt: string, draft = false) =>
    api<{ task: Task }>('POST', '/api/tasks', { project, prompt, draft }),
  drafts: () => api<{ drafts: Task[] }>('GET', '/api/drafts'),
  setup: () => api<{ report: Array<{ name: string; ok: boolean; detail: string; required: boolean }> }>('GET', '/api/setup/check'),
  draftOp: (id: number, op: 'edit' | 'moveBefore' | 'enqueue', extra?: { prompt?: string; beforeId?: number }) =>
    api<{ ok: boolean }>('POST', `/api/tasks/${id}/draft`, { op, ...extra }),
  createProject: (name: string, workspace_path: string, agent_id = 'codex', execution = 'capability') =>
    api<{ project: Project }>('POST', '/api/projects', { name, workspace_path, agent_id, execution }),
  updateProject: (id: number, body: { execution?: string; extraPackages?: string[]; mcpServers?: string[] }) =>
    api<{ project: Project }>('PATCH', `/api/projects/${id}`, body),
  recheckProject: (id: number) =>
    api<{ report: Array<{ name: string; ok: boolean; detail: string }> }>('POST', `/api/projects/${id}/recheck`),
  deleteProject: (id: number) =>
    api<{ ok: boolean }>('DELETE', `/api/projects/${id}`),
  action: (id: number, type: string, feedback?: string) =>
    api<{ ok: boolean; message?: string }>('POST', `/api/tasks/${id}/actions`, { type, feedback }),
};

export const STATUS_META: Record<TaskStatus, { label: string; color: string; bg: string }> = {
  draft:    { label: '📝 草稿',   color: '#57606a', bg: '#eef0f2' },
  queued:   { label: '🕐 排队',   color: '#8a6d00', bg: '#fff6d9' },
  running:  { label: '🔄 运行中', color: '#0b62d6', bg: '#e3f0ff' },
  blocked:  { label: '⚠️ 阻塞',   color: '#ad5f00', bg: '#ffeccd' },
  done:     { label: '✅ 完成',   color: '#1a7f37', bg: '#e2f5e8' },
  failed:   { label: '❌ 失败',   color: '#c01d2e', bg: '#fde8ea' },
  cancelled:{ label: '🚫 取消',   color: '#57606a', bg: '#eef0f2' },
};
