/**
 * 分层配置：代码默认值 → 用户配置文件 → 环境变量（AGENTDESK_节__键）→ CLI 覆盖。
 * 业务代码零字面量：镜像名、并发、端口、卷名、代理、数据目录全部从这里出。
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AppConfig {
  server: { host: string; port: number; token: string; publicUrl: string };
  scheduler: { concurrency: number; tickMs: number; taskTimeoutMin: number };
  /** agent 配置是开放字典：注册表里有什么 id，这里就能配什么 */
  agents: Record<string, {
    image: string;
    codexHomeVolume: string;
    hostSkillsDir?: string;
    /** 全局 MCP server 注册表：项目 mcpServers 按名字从这里取配置 */
    mcp?: Record<string, { url?: string; command?: string; args?: string[] }>;
  }>;
  /** 通知渠道列表（M3 起各渠道实现读这里；M1 只有 console） */
  notify: { channels: Array<Record<string, unknown>> };
  /** 反馈通道：把人的决定送回 daemon（钉钉 Stream = 手机闭环） */
  feedback: { dingtalkStream?: { clientId: string; clientSecret: string } };
  dataDir: string;
  proxy: { httpsProxy: string; httpProxy: string };
}

const DEFAULTS: AppConfig = {
  server: { host: '127.0.0.1', port: 8787, token: '', publicUrl: '' },
  scheduler: { concurrency: 1, tickMs: 5000, taskTimeoutMin: 30 },
  agents: {
    codex: {
      image: 'agentdesk/runner-codex:m0',
      codexHomeVolume: 'agentdesk-codex-home',
      // 宿主 GUI/CLI 的全局 skills 目录：存在则每次任务前单向播种进 codex-home 卷
      hostSkillsDir: join(homedir(), '.codex', 'skills'),
      // MCP server 注册表：项目声明 mcpServers 按名字取配置后渲染进容器 config.toml
      mcp: {
        // "chrome-devtools-lab": { url: "http://host.docker.internal:9222/mcp" },
      },
    },
  },
  notify: { channels: [] },
  feedback: {},
  dataDir: join(homedir(), '.agentdesk'),
  proxy: { httpsProxy: '', httpProxy: '' },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

function coerce(v: string): string | number | boolean {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function loadConfig(overrides?: { configPath?: string; dataDir?: string; port?: number }): AppConfig {
  let cfg = structuredClone(DEFAULTS);

  // ① 用户配置文件
  const file = overrides?.configPath
    ?? process.env.AGENTDESK_CONFIG
    ?? join(homedir(), '.agentdesk', 'config.json');
  if (existsSync(file)) {
    cfg = deepMerge(cfg, JSON.parse(readFileSync(file, 'utf8')));
  }

  // ② 环境变量：AGENTDESK_SCHEDULER__CONCURRENCY=2 → scheduler.concurrency
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('AGENTDESK_') || key === 'AGENTDESK_CONFIG' || value === undefined) continue;
    const path = key.slice('AGENTDESK_'.length).split('__').map(s => s.toLowerCase());
    let node: Record<string, unknown> = cfg as unknown as Record<string, unknown>;
    for (let i = 0; i < path.length - 1; i++) {
      const k = path[i]!;
      if (!isPlainObject(node[k])) node[k] = {};
      node = node[k] as Record<string, unknown>;
    }
    node[path[path.length - 1]!] = coerce(value);
  }

  // ③ CLI 覆盖（最高优先级）
  if (overrides?.dataDir) cfg.dataDir = overrides.dataDir;
  if (overrides?.port) cfg.server.port = overrides.port;

  // ④ 代理兜底：配置为空时沿用进程环境（开发时 .env 注入的 host.docker.internal 代理）
  if (!cfg.proxy.httpsProxy && process.env.HTTPS_PROXY) cfg.proxy.httpsProxy = process.env.HTTPS_PROXY;
  if (!cfg.proxy.httpProxy && process.env.HTTP_PROXY) cfg.proxy.httpProxy = process.env.HTTP_PROXY;

  return cfg;
}
