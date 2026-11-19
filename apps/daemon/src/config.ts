/**
 * 分层配置：代码默认值 → 用户配置文件 → 环境变量（AGENTDESK_节__键）→ CLI 覆盖。
 * 业务代码零字面量：镜像名、并发、端口、卷名、代理、数据目录全部从这里出。
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { savedLogDirectory } from './log-settings.js';

export function loadLocalEnv(): void {
  const path = join(process.env.AGENTDESK_APP_DIR ?? process.cwd(), '.env');
  if (existsSync(path)) loadEnvFile(path);
}

export interface DingTalkReportConfig {
  executable: string;
  configDir: string;
  profile?: string;
  folder?: string;
}

export interface AppConfig {
  server: { host: string; port: number; token: string; publicUrl: string };
  scheduler: { concurrency: number; tickMs: number; /** Legacy setting, ignored for task execution. */ taskTimeoutMin: number; inactivityWarningMin: number };
  /** agent 配置是开放字典：注册表里有什么 id，这里就能配什么 */
  agents: Record<string, {
    image: string;
    codexHomeVolume: string;
    /** 宿主 CLI 路径；空值自动发现桌面端内置运行时。 */
    executable?: string;
    hostSkillsDir?: string;
    /** 全局 MCP server 注册表：项目 mcpServers 按名字从这里取配置 */
    mcp?: Record<string, { url?: string; command?: string; args?: string[] }>;
  }>;
  /** 通知渠道列表（M3 起各渠道实现读这里；M1 只有 console） */
  notify: { channels: Array<Record<string, unknown>>; dingtalkReport?: DingTalkReportConfig };
  /** 反馈通道：把人的决定送回 daemon（钉钉 Stream = 手机闭环） */
  feedback: { dingtalkStream?: DingTalkStreamConfig };
  dataDir: string;
  logDir: string;
  proxy: { httpsProxy: string; httpProxy: string; nativeHttpsProxy: string; nativeHttpProxy: string };
}

export interface DingTalkStreamConfig {
  clientId: string;
  clientSecret: string;
  allowedSenderIds?: string[];
  allowedConversationIds?: string[];
}

const DEFAULTS: AppConfig = {
  server: { host: '127.0.0.1', port: 8787, token: '', publicUrl: '' },
  scheduler: { concurrency: 1, tickMs: 5000, taskTimeoutMin: 0, inactivityWarningMin: 10 },
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
    zcode: { image: '', codexHomeVolume: '' },
    deepseek: { image: '', codexHomeVolume: '' },
  },
  notify: { channels: [], dingtalkReport: { executable: '', configDir: '', profile: '', folder: '' } },
  feedback: {},
  dataDir: join(homedir(), '.agentdesk'),
  logDir: '',
  proxy: { httpsProxy: '', httpProxy: '', nativeHttpsProxy: '', nativeHttpProxy: '' },
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

export function loadConfig(overrides?: { configPath?: string; dataDir?: string; logDir?: string; port?: number }): AppConfig {
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
    const path = key.slice('AGENTDESK_'.length).split('__');
    if (path.length < 2) continue; // CLI/工具环境变量单独读取
    let node: Record<string, unknown> = cfg as unknown as Record<string, unknown>;
    const field = (section: Record<string, unknown>, part: string) =>
      Object.keys(section).find(name => name.toLowerCase() === part.toLowerCase());
    if (['scheduler', 'server', 'proxy'].includes(path[0]!.toLowerCase())) {
      const section = field(node, path[0]!);
      if (!section || !isPlainObject(node[section]) || path.length !== 2 || !field(node[section], path[1]!)) {
        throw new Error(`未知配置环境变量 ${key}`);
      }
    }
    for (let i = 0; i < path.length - 1; i++) {
      const k = field(node, path[i]!) ?? path[i]!.toLowerCase();
      if (['__proto__', 'constructor', 'prototype'].includes(k)) throw new Error(`无效配置环境变量 ${key}`);
      if (!isPlainObject(node[k])) node[k] = {};
      node = node[k] as Record<string, unknown>;
    }
    const leaf = field(node, path.at(-1)!) ?? path.at(-1)!.toLowerCase();
    if (['__proto__', 'constructor', 'prototype'].includes(leaf)) throw new Error(`无效配置环境变量 ${key}`);
    if (path[0]!.toLowerCase() === 'scheduler' || (path[0]!.toLowerCase() === 'server' && leaf === 'port')) {
      node[leaf] = coerce(value);
    } else {
      node[leaf] = value;
    }
  }

  // ③ CLI 覆盖（最高优先级）
  cfg.dataDir = overrides?.dataDir ?? process.env.AGENTDESK_DATA_DIR ?? cfg.dataDir;
  const logDir = overrides?.logDir ?? savedLogDirectory(cfg.dataDir) ?? process.env.AGENTDESK_LOG_DIR ?? cfg.logDir;
  if (typeof logDir !== 'string') throw new Error('logDir 必须为目录路径字符串');
  cfg.logDir = resolve(cfg.dataDir, logDir);
  cfg.server.port = overrides?.port ?? cfg.server.port;
  if (!Number.isInteger(cfg.server.port) || cfg.server.port < 1 || cfg.server.port > 65535) {
    throw new Error('server.port 必须为 1–65535 的整数');
  }

  // ④ 代理兜底：配置为空时沿用进程环境（开发时 .env 注入的 host.docker.internal 代理）
  if (!cfg.proxy.httpsProxy && process.env.HTTPS_PROXY) cfg.proxy.httpsProxy = process.env.HTTPS_PROXY;
  if (!cfg.proxy.httpProxy && process.env.HTTP_PROXY) cfg.proxy.httpProxy = process.env.HTTP_PROXY;

  for (const key of ['concurrency', 'tickMs', 'inactivityWarningMin'] as const) {
    if (!Number.isSafeInteger(cfg.scheduler[key]) || cfg.scheduler[key] < 1) {
      throw new Error(`scheduler.${key} 必须为正整数`);
    }
  }
  if (!Number.isSafeInteger(cfg.scheduler.taskTimeoutMin) || cfg.scheduler.taskTimeoutMin < 0) throw new Error('旧配置 scheduler.taskTimeoutMin 必须为非负整数');
  const report = cfg.notify.dingtalkReport;
  if (report?.executable && (typeof report.executable !== 'string'
    || typeof report.configDir !== 'string' || !report.configDir.trim())) {
    throw new Error('notify.dingtalkReport 需要有效的 executable 和 configDir');
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(cfg.server.host) &&
      (typeof cfg.server.token !== 'string' || !cfg.server.token.trim())) {
    throw new Error('daemon 监听非回环地址时必须配置 server.token');
  }

  return cfg;
}
