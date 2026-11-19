/** 前端共享类型与 API 客户端（与 daemon REST 一一对应） */

import { taskStateLabel, type Project, type TaskView, type Run, type RunDetails, type TaskActions, type TaskState, type LanguagePreference } from '@agentdesk/core';
import type { DiagnosticReport, EnvironmentCheck, ReasoningOption } from '@agentdesk/core';
export type { Project, TaskView as Task, Run } from '@agentdesk/core';

export interface MergeStatus {
  repo?: string;
  pr?: number;
  verified?: { base: string; head: string };
  completed?: string;
}

export interface ProjectFolder { name: string; path: string }
export interface LogSettings { currentDir: string; configuredDir: string; dataDir: string; restartRequired: boolean }
export interface NetworkSettings { mode: 'custom' | 'inherit'; url: string; httpsProxy?: string; httpProxy?: string }
export interface AgentInfo {
  id: string; label: string; available: boolean; modes: string[];
  models: Array<{ id: string; label: string; reasoningOptions?: ReasoningOption[] }>; defaultModel?: string;
  executable?: string; command?: string[]; configuredPath?: string; detectedPaths: string[];
}

export interface ProjectFolderListing {
  current: ProjectFolder | null;
  parent: string | null;
  folders: ProjectFolder[];
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
  diagnose: (task?: number, run?: number) => api<DiagnosticReport>('GET', task ? `/api/tasks/${task}/diagnostics${run ? '?run=' + run : ''}` : '/api/diagnostics'),
  logSettings: () => api<LogSettings>('GET', '/api/settings/storage'),
  updateLogSettings: (logDir: string) => api<LogSettings>('PATCH', '/api/settings/storage', { logDir }),
  networkSettings: () => api<NetworkSettings>('GET', '/api/settings/network'),
  updateNetwork: (url: string) => api<NetworkSettings>('PATCH', '/api/settings/network', { url }),
  testNetwork: (url: string) => api<{ ok: boolean; message: string }>('POST', '/api/settings/network/test', { url }),
  agents: (refresh = false) => api<{ agents: string[]; details: AgentInfo[] }>('GET', `/api/agents${refresh ? '?refresh=1' : ''}`),
  updateAgentPath: (id: string, executable: string) => api<{ details: AgentInfo[] }>('PATCH', `/api/settings/agents/${id}`, { executable }),
  dingtalkSettings: () => api<{ language: LanguagePreference }>('GET', '/api/settings/dingtalk'),
  updateDingtalkSettings: (language: LanguagePreference) => api<{ language: LanguagePreference }>('PATCH', '/api/settings/dingtalk', { language }),
  projects: () => api<{ projects: Project[] }>('GET', '/api/projects'),
  tasks: () => api<{ tasks: TaskView[] }>('GET', '/api/tasks'),
  task: (id: number) => api<{ task: TaskView; runs: Run[]; details?: RunDetails; repeatedFailure?: { count: number; hint: string }; reportDeliveries?: Array<{ runId: number; state: string; lastError?: string; nextAt?: number }>; actions: TaskActions; agentId?: string; merge?: MergeStatus }>('GET', `/api/tasks/${id}`),
  retryReport: (id: number, runId: number) => api<{ scheduled: number }>('POST', `/api/tasks/${id}/report/retry`, { runId }),
  runLog: (id: number, before?: number) => api<{ text: string; before: number | null }>(
    'GET', `/api/runs/${id}/log${before === undefined ? '' : `?before=${before}`}`,
  ),
  createTask: (project: string | number, prompt: string, draft = false) =>
    api<{ task: TaskView }>('POST', '/api/tasks', { project, prompt, draft }),
  drafts: () => api<{ drafts: TaskView[] }>('GET', '/api/drafts'),
  projectFolders: (path?: string) => api<ProjectFolderListing>('POST', '/api/project-folders', { path }),
  draftOp: (id: number, op: 'edit' | 'moveBefore' | 'enqueue', extra?: { prompt?: string; beforeId?: number }) =>
    api<{ ok: boolean }>('POST', `/api/tasks/${id}/draft`, { op, ...extra }),
  reasoningOptions: (agent: string, model: string) => api<{ model?: string; options: ReasoningOption[] }>('GET', `/api/agents/${encodeURIComponent(agent)}/reasoning?model=${encodeURIComponent(model)}`),
  createProject: (name: string, workspace_path: string, agent_id = 'codex', execution = 'capability', model?: string | null, reasoning_effort?: string | null) =>
    api<{ project: Project }>('POST', '/api/projects', { name, workspace_path, agent_id, execution, model, reasoning_effort }),
  updateProject: (id: number, body: { agent_id?: string; model?: string | null; reasoning_effort?: string | null; execution?: string; extraPackages?: string[]; mcpServers?: string[] }) =>
    api<{ project: Project }>('PATCH', `/api/projects/${id}`, body),
  recheckProject: (id: number) =>
    api<{ report: Array<EnvironmentCheck & { name: string; detail: string }> }>('POST', `/api/projects/${id}/recheck`),
  deleteProject: (id: number) =>
    api<{ ok: boolean }>('DELETE', `/api/projects/${id}`),
  action: (id: number, type: string, feedback?: string, runId?: number) =>
    api<{ ok: boolean; message?: string }>('POST', `/api/tasks/${id}/actions`, { type, feedback, runId }),
};

const STATUS_META: Record<TaskState, { color: string; bg: string }> = {
  draft: { color: '#57606a', bg: '#eef0f2' },
  queued: { color: '#8a6d00', bg: '#fff6d9' },
  running: { color: '#0b62d6', bg: '#e3f0ff' },
  awaiting_confirmation: { color: '#ad5f00', bg: '#ffeccd' },
  ended: { color: '#57606a', bg: '#eef0f2' },
  cancelled: { color: '#57606a', bg: '#eef0f2' },
};

export const taskStatusMeta = (task: TaskView) => ({ label: taskStateLabel(task), ...STATUS_META[task.state] });
