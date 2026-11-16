/** 从共享卷读取基础配置，为单次容器运行生成只读 MCP 配置。 */
import type Docker from 'dockerode';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';

export interface McpServerConfig {
  url?: string;
  command?: string;
  args?: string[];
}

export function renderMcpConfig(
  base: string,
  requested: string[],
  registry: Record<string, McpServerConfig>,
): { toml: string; written: string[]; skipped: string[] } {
  const written: string[] = [];
  const skipped: string[] = [];
  const servers: Record<string, McpServerConfig> = Object.create(null);
  for (const name of new Set(requested)) {
    if (!Object.hasOwn(registry, name)) { skipped.push(name); continue; }
    const server = registry[name]!;
    servers[name] = Object.fromEntries(Object.entries(server).filter(([, value]) => value !== undefined));
    written.push(name);
  }
  try {
    const config = parse(base);
    return { toml: stringify({ ...config, mcp_servers: servers }), written, skipped };
  } catch {
    throw new Error('无法解析或生成隔离模式的 Codex TOML 配置，请检查共享卷配置');
  }
}

export async function prepareMcpConfig(
  docker: Docker, volumeName: string, requested: string[], registry: Record<string, McpServerConfig>,
): Promise<{ path: string; written: string[]; skipped: string[]; cleanup: () => void }> {
  const reader = await docker.createContainer({
    Image: 'alpine:latest',
    Cmd: ['sh', '-c', 'if [ -f /codex-home/config.toml ]; then cat /codex-home/config.toml; fi'],
    Tty: true,
    HostConfig: { Binds: [volumeName + ':/codex-home:ro'] },
    Labels: { 'agentdesk.mcp': 'read-config' },
  });
  let base: string;
  try {
    await reader.start();
    const result = await reader.wait();
    if (result.StatusCode) throw new Error('无法读取共享卷中的 Codex 配置');
    const raw = await reader.logs({ stdout: true, stderr: false, follow: false });
    base = raw.toString('utf8');
  } finally {
    await reader.remove({ force: true }).catch(() => {});
  }
  const config = renderMcpConfig(base, requested, registry);
  const dir = mkdtempSync(join(tmpdir(), 'agentdesk-mcp-'));
  const path = join(dir, 'config.toml');
  const cleanup = () => {
    try { unlinkSync(path); } catch { /* 配置文件可能尚未创建 */ }
    try { rmdirSync(dir); } catch { /* 文件被占用时保留目录 */ }
  };
  try {
    writeFileSync(path, config.toml, { flag: 'wx', mode: 0o600 });
    return { path, written: config.written, skipped: config.skipped, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
