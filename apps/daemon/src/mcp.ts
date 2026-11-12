/**
 * MCP 声明 → 容器 config.toml 渲染。
 *
 * 背景：昨晚 #16 反复阻塞的直接原因是任务需要 chrome-devtools-lab MCP，
 * 但容器内 codex 的 config.toml 里没有该声明 → agent 反复请求"接入 MCP"死循环。
 *
 * 机制：项目声明 mcpServers（名字列表）→ daemon 从全局注册表取 server 配置
 * → 写入 codex-home 卷的 config.toml（[mcp_servers.xxx] 段）。
 * 未在注册表里的名字会被跳过——契约第 3 条让 agent 不再请求未配置的工具。
 *
 * codex 0.16x 的 config.toml MCP 段格式：
 *   [mcp_servers.chrome-devtools-lab]
 *   url = "http://host.docker.internal:9222/mcp"
 *
 * codex-home 是 named volume（宿主无直接路径）→ 用一次性 alpine 容器写入。
 * alpine 里没有 node/python → 渲染在 daemon 侧完成，容器只负责"写文件"。
 */
import Docker from 'dockerode';
import { writeFileSync, unlinkSync } from 'node:fs';

export interface McpServerConfig {
  url?: string;
  command?: string;
  args?: string[];
}

/** daemon 侧渲染：生成 config.toml 的 MCP 段文本 */
export function renderMcpToml(
  requested: string[],
  registry: Record<string, McpServerConfig>,
): { toml: string; written: string[]; skipped: string[] } {
  const seg: string[] = [];
  const written: string[] = [];
  const skipped: string[] = [];
  for (const name of requested) {
    const conf = registry[name];
    if (!conf) { skipped.push(name); continue; }
    written.push(name);
    seg.push(`[mcp_servers.${name}]`);
    if (conf.url) seg.push(`url = "${conf.url}"`);
    if (conf.command) seg.push(`command = "${conf.command}"`);
    if (conf.args?.length) seg.push(`args = [${conf.args.map(a => JSON.stringify(a)).join(', ')}]`);
    seg.push('');
  }
  return { toml: seg.join('\n'), written, skipped };
}

/** 把 MCP 段合并写入 named volume 内的 config.toml（一次性容器作为写入代理） */
export async function writeMcpToVolume(
  docker: Docker,
  volumeName: string,
  mcpToml: string,
): Promise<void> {
  // 先在本机临时文件生成完整目标内容（保持无 MCP 段时文件为空串也可）
  const tmp = `agentdesk-mcp-${Date.now()}.toml`;
  writeFileSync(tmp, mcpToml);
  try {
    const c = await docker.createContainer({
      Image: 'alpine:latest',
      Cmd: ['sh', '-c',
        'mkdir -p /codex-home && ' +
        'grep -v "^\\[mcp_servers\\." /codex-home/config.toml 2>/dev/null > /codex-home/config.toml.base; ' +
        'cat /config.toml >> /codex-home/config.toml.base 2>/dev/null; ' +
        'mv /codex-home/config.toml.base /codex-home/config.toml'],
      HostConfig: {
        Binds: [`${volumeName}:/codex-home`, `${process.cwd()}/${tmp}:/${tmp}`],
      },
      Labels: { 'agentdesk.mcp': 'render' },
    });
    await c.start();
    await c.wait();
    try { await c.remove(); } catch { /* noop */ }
  } finally {
    try { unlinkSync(tmp); } catch { /* noop */ }
  }
}
