/** 环境检查由 CLI 和本机 Web 共用，按执行模式选择依赖。 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ExecutionMode } from '@agentdesk/core';
import { loadConfig, type AppConfig } from './config.js';
import { hostGitAvailable } from './hostgit.js';
import { hostCodexLoginStatus, hostCodexProxyEnv, runNative } from './native.js';
import { ghExecutable } from './merge.js';
import { agentCatalog, findNativeAgent } from './agent-runtime.js';
import { availableAgents } from '@agentdesk/adapters';

export interface DoctorRow { name: string; ok: boolean; detail: string; required: boolean }

const exec = promisify(execFile);

export async function runDoctor(
  cfg: AppConfig = loadConfig(),
  options: { mode?: ExecutionMode; projectPath?: string; merge?: boolean; agentId?: string } = {},
): Promise<DoctorRow[]> {
  const rows: DoctorRow[] = [];
  if (options.agentId && !availableAgents().includes(options.agentId)) throw new Error('未知 Agent');
  const catalog = agentCatalog(cfg);
  const codexRequired = options.agentId === 'codex' || !catalog.some(agent => agent.id !== 'codex' && agent.available);
  const check = async (name: string, required: boolean, fn: () => Promise<string>, failure: string) => {
    try { rows.push({ name, ok: true, detail: await fn(), required }); }
    catch { rows.push({ name, ok: false, detail: failure, required }); }
  };
  const run = async (cmd: string, args: string[]) => (await exec(cmd, args, { timeout: 6_000, windowsHide: true })).stdout.trim();
  const git = await hostGitAvailable();
  rows.push({ name: '宿主 Git', ok: git.ok, detail: git.ok ? git.version : '请安装 Git 并将其加入 PATH。', required: true });

  if (options.mode === 'isolation') {
    await check('Docker 引擎', true, () => run('docker', ['version', '--format', '{{.Server.Version}}']), '请启动 Docker 并检查当前账号的访问权限。');
    await check('Runner 镜像', true,
      () => run('docker', ['image', 'inspect', cfg.agents.codex!.image, '--format', '{{.Id}}']),
      '请先准备隔离模式的 Runner 镜像。');
    await check('容器 Codex 凭证', true, async () => {
      await run('docker', ['run', '--rm', '--pull=never', '-v',
        cfg.agents.codex!.codexHomeVolume + ':/codex-home:ro', '--entrypoint', '/bin/sh',
        cfg.agents.codex!.image, '-c', 'test -f /codex-home/auth.json']);
      return '容器卷里已有凭证。';
    }, '请运行 desk auth --isolation。');
  } else if (!options.agentId || options.agentId === 'codex') {
    const codex = findNativeAgent('codex', cfg)?.command[0];
    rows.push({ name: '宿主 Codex CLI', ok: !!codex, required: codexRequired,
      detail: codex ?? '请安装官方 Codex CLI，或通过 AGENTDESK_CODEX_PATH 指定可执行文件。' });
    if (codex) {
      await check('宿主 Codex 登录', codexRequired, async () => {
        const result = await hostCodexLoginStatus(codex, cfg.proxy);
        if (result.exitCode !== 0) throw new Error('Codex login status failed');
        return '当前运行账号已登录。';
      }, '用当前系统账号运行 desk auth。');
      await check('Codex 版本', false, async () => {
        const result = await runNative({ cmd: [codex, '--version'], cwd: process.cwd(),
          env: hostCodexProxyEnv(cfg.proxy), timeoutMs: 6_000 });
        if (result.exitCode !== 0) throw new Error('Codex --version failed');
        return result.out.join(' ');
      }, '无法查询宿主 Codex 版本。');
    }
  } else {
    const agent = findNativeAgent(options.agentId, cfg);
    rows.push({ name: `${options.agentId} CLI`, ok: !!agent, required: true,
      detail: agent ? agent.command.join(' · ') : `请安装对应客户端，或配置 agents.${options.agentId}.executable。` });
  }
  if (!options.agentId && options.mode !== 'isolation') for (const agent of catalog.filter(agent => agent.id !== 'codex')) {
    rows.push({ name: `${agent.label} CLI`, ok: agent.available, required: false, detail: agent.available ? agent.command!.join(' · ') : `未检测到${agent.configuredPath ? '：' + agent.configuredPath : '，可安装后使用'}。` });
  }
  if (options.mode !== 'isolation' && (!options.agentId || options.agentId === 'zcode')) {
    const zcode = findNativeAgent('zcode', cfg);
    const script = zcode?.command.find(path => /zcode\.cjs$/i.test(path));
    if (script) {
      const builtin = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || join(dirname(script), '..', 'config', 'provider', 'zcode-builtin.json');
      const personal = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(process.env.ZCODE_DATA_BASE_DIR || homedir(), '.zcode', 'v2', 'provider_config.json');
      const required = options.agentId === 'zcode' || catalog.filter(agent => agent.available).length === 1;
      rows.push({ name: 'ZCode 供应商配置', ok: existsSync(builtin) && existsSync(personal), required,
        detail: existsSync(builtin) && existsSync(personal) ? '已找到内置和用户供应商配置；模型连接需通过实际任务验证。'
          : '供应商配置文件缺失：重新检测 CLI 路径，并在 ZCode 中完成供应商配置和登录。' });
    }
  }

  if (options.projectPath) {
    const path = options.projectPath;
    await check('项目目录', true, async () => {
      if (!statSync(path).isDirectory()) throw new Error('Not a directory');
      return path;
    }, '路径不存在或当前账号无法访问。');
    await check('Git 工作区', true, () => run('git', ['-C', path, 'rev-parse', '--show-toplevel']), '请选择可访问的本机 Git 工作区。');
    await check('Git 提交身份', true, async () => {
      await run('git', ['-C', path, 'var', 'GIT_AUTHOR_IDENT']);
      await run('git', ['-C', path, 'var', 'GIT_COMMITTER_IDENT']);
      return '已配置。';
    }, '请给该仓库配置 Git 的 user.name 和 user.email。');
  }
  if (options.merge) {
    await check('GitHub CLI（自动化合并）', true, async () => {
      await run(ghExecutable(), ['auth', 'status', '--hostname', 'github.com']);
      return '当前账号已登录。';
    }, '请安装 GitHub CLI，再运行 gh auth login。');
  }
  return rows;
}

export function printDoctor(rows: DoctorRow[]): number {
  console.log('\n🩺 Runember doctor');
  for (const row of rows) console.log(`${row.ok ? '✅' : row.required ? '❌' : '⚠️ '} ${row.name} — ${row.detail}`);
  if (rows.some(row => row.required && !row.ok)) return 1;
  console.log('\n通过环境检查。可以派一条只读任务验证模型连接。');
  return 0;
}
