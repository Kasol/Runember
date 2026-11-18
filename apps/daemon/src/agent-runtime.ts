import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, unlinkSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, isAbsolute } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml, stringify as yaml } from 'yaml';
import { agentDefinitions } from '@agentdesk/adapters';
import type { Store } from './store.js';
import type { AppConfig } from './config.js';
import { zcodeBridgeMain } from './zcode-bridge.js';

interface NativeAgent { command: string[]; env: string[]; executable: string }

/** Saved overrides apply at the next run, without changing an executing process. */
export function runtimeConfig(cfg: AppConfig, store: Pick<Store, 'getSetting'>): AppConfig {
  const agents = { ...cfg.agents };
  for (const { id } of agentDefinitions) {
    const saved = store.getSetting(`agents.${id}.executable`);
    if (saved !== undefined) agents[id] = { ...agents[id]!, executable: saved };
  }
  return { ...cfg, agents };
}

function isFile(path: string): boolean { try { return statSync(path).isFile(); } catch { return false; } }

export function detectedAgentPaths(id: string): string[] {
  const candidates: string[] = [];
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(path => path.replace(/^"|"$/g, ''))) {
    const name = id === 'codex' ? 'codex' : id === 'zcode' ? 'zcode' : 'dsh';
    candidates.push(join(directory, process.platform === 'win32' ? name + '.exe' : name));
    if (id === 'codex') {
      const vendor = join(directory, 'node_modules', '@openai', 'codex', 'vendor');
      try { for (const arch of readdirSync(vendor)) candidates.push(join(vendor, arch, 'codex', 'codex.exe')); } catch {}
      // Recent npm releases store the native binary in an optional platform package.
      for (const root of [join(directory, 'node_modules'), join(directory, 'node_modules', '@openai', 'codex', 'node_modules')]) {
        for (const arch of ['x64', 'arm64']) candidates.push(join(root, '@openai', `codex-win32-${arch}`, 'vendor', `${arch === 'x64' ? 'x86_64' : 'aarch64'}-pc-windows-msvc`, 'codex', 'codex.exe'));
      }
    }
    if (id === 'deepseek') candidates.push(join(directory, 'dsh.cmd'), join(directory, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'));
  }
  if (id === 'codex') {
    if (process.platform === 'win32') {
      const root = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
      try { candidates.push(...readdirSync(root).map(hash => join(root, hash, 'codex.exe')).filter(isFile).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)); } catch {}
    } else if (process.platform === 'darwin') {
      for (const root of ['/Applications', join(homedir(), 'Applications')]) candidates.push(join(root, 'Codex.app', 'Contents', 'Resources', 'codex'));
    }
  } else for (const root of desktopRoots()) candidates.push(id === 'zcode' ? join(root, process.platform === 'darwin' ? 'Resources' : 'resources', 'glm', 'zcode.cjs')
    : process.platform === 'darwin' ? join(root, 'MacOS', 'DeepSeek Harness') : join(root, 'DeepSeek Harness.exe'));
  return [...new Set(candidates.map(path => resolve(path)))].filter(isFile);
}

export function validateAgentPath(id: string, value: string, cfg: AppConfig): string {
  const path = value.trim();
  if (!path || !isAbsolute(path) || !isFile(path)) throw new Error('请选择存在的 CLI 文件，路径必须为绝对路径。');
  if (id === 'codex' && process.platform === 'win32' && !/\.exe$/i.test(path)) throw new Error('Codex 请选择 codex.exe；自动检测会解析 npm 安装的原生入口。');
  const candidate = { ...cfg, agents: { ...cfg.agents, [id]: { ...cfg.agents[id]!, executable: path } } };
  if (!findNativeAgent(id, candidate)) throw new Error('无法解析此 CLI 入口，请选择可执行文件或受支持的官方启动脚本。');
  return resolve(path);
}
let installationCache: { at: number; roots: string[] } | undefined;
export function refreshAgentDiscovery(): void { installationCache = undefined; }

function desktopRoots(): string[] {
  if (installationCache && Date.now() - installationCache.at < 30_000) return installationCache.roots;
  const roots: string[] = [];
  if (process.platform === 'darwin') {
    for (const directory of ['/Applications', join(homedir(), 'Applications')]) {
      for (const name of ['ZCode', 'Z Code', 'DeepSeek Harness', 'dsh-desktop']) roots.push(join(directory, `${name}.app`, 'Contents', 'Resources', '..'));
    }
  }
  for (const folder of [process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles]) {
    if (folder) for (const name of ['ZCode', 'DeepSeek Harness', 'dsh-desktop']) roots.push(join(folder, name));
  }
  if (process.platform === 'win32') {
    try {
      const script = "$r=@(); Get-Process -Name 'ZCode','DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object {if($_.Path){$r+=Split-Path -Parent $_.Path}}; Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object {$_.DisplayName -match 'ZCode|DeepSeek Harness'} | ForEach-Object {if($_.InstallLocation){$r+=$_.InstallLocation};if($_.DisplayIcon){$r+=Split-Path -Parent ($_.DisplayIcon -replace ',\\d+$','' -replace '\"','')}}; ConvertTo-Json -InputObject @($r | Select-Object -Unique) -Compress";
      const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
      if (Array.isArray(result)) roots.push(...result.filter(value => typeof value === 'string'));
    } catch { /* Explicit configuration and standard installation paths still work. */ }
  }
  installationCache = { at: Date.now(), roots: [...new Set(roots)] };
  return installationCache.roots;
}

export function findNativeAgent(id: string, cfg: AppConfig): NativeAgent | undefined {
  const explicit = cfg.agents[id]?.executable ?? process.env[`AGENTDESK_${id.toUpperCase()}_PATH`];
  const candidates = explicit ? [resolve(explicit)] : detectedAgentPaths(id);
  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    if (/\.(cmd|bat)$/i.test(candidate)) {
      // Resolve the official Windows shim to its real entry, without invoking a shell.
      const desktop = resolve(dirname(candidate), '..', '..', '..', '..', 'DeepSeek Harness.exe');
      if (id === 'deepseek' && existsSync(desktop) && readFileSync(candidate, 'utf8').includes('dsh-desktop-host')) return {
        command: [desktop, '--expose-internals', join(dirname(desktop), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')],
        env: ['ELECTRON_RUN_AS_NODE=1'], executable: candidate,
      };
      const node = join(dirname(candidate), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
      if (id === 'deepseek' && existsSync(node)) return { command: [process.execPath, node], env: [], executable: candidate };
      continue;
    }
    const resources = process.platform === 'darwin' ? resolve(dirname(candidate), '..', 'Resources') : join(dirname(candidate), 'resources');
    if (id === 'deepseek' && existsSync(join(resources, 'app.asar'))) return {
      command: [candidate, '--expose-internals', join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')],
      env: ['ELECTRON_RUN_AS_NODE=1'], executable: candidate,
    };
    if (id === 'zcode' && existsSync(join(resources, 'glm', 'zcode.cjs'))) return {
      command: [process.execPath, join(resources, 'glm', 'zcode.cjs')], env: [], executable: candidate,
    };
    if (process.platform === 'win32' && !/\.(exe|c?js|mjs)$/i.test(candidate)) continue;
    return { command: /\.(?:c?js|mjs)$/i.test(candidate) ? [process.execPath, candidate] : [candidate], env: [], executable: candidate };
  }
}

function readJson(path: string): any { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; } }
function dshHome(): string { return process.env.DSH_HOME || join(homedir(), '.dsh'); }

function deepseekSelection(): { provider: string; model: string } {
  try {
    const patches = parseYaml(readFileSync(join(dshHome(), 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8'), { logLevel: 'silent' });
    const config = Array.isArray(patches) ? patches.find(item => item?.id === 'agent-default-model')?.config : undefined;
    if (typeof config?.provider === 'string' && typeof config?.model === 'string') return config;
  } catch { /* API-key headless defaults apply. */ }
  return { provider: 'deepseek-official', model: 'deepseek-flash' };
}

export interface AgentInfo {
  id: string; label: string; available: boolean; modes: readonly string[];
  models: Array<{ id: string; label: string }>; defaultModel?: string;
  executable?: string; command?: string[]; configuredPath?: string; detectedPaths: string[];
}

export function agentCatalog(cfg: AppConfig): AgentInfo[] {
  return agentDefinitions.map(definition => {
    const runtime = findNativeAgent(definition.id, cfg);
    const models: AgentInfo['models'] = [];
    let defaultModel: string | undefined;
    if (definition.id === 'codex') {
      try { const config = parseToml(readFileSync(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'), 'utf8')); defaultModel = typeof config.model === 'string' ? config.model : undefined; } catch {}
      const cached = readJson(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'models_cache.json'));
      for (const model of cached?.models ?? []) if (typeof model.slug === 'string') models.push({ id: model.slug, label: model.display_name ?? model.slug });
    } else if (definition.id === 'deepseek') {
      const selected = deepseekSelection(); defaultModel = `${selected.provider}/${selected.model}`;
      models.push({ id: defaultModel, label: defaultModel });
    } else {
      const personal = readJson(process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(process.env.ZCODE_DATA_BASE_DIR || homedir(), '.zcode', 'v2', 'provider_config.json'))?.config;
      const script = runtime?.command.find(path => /zcode\.cjs$/i.test(path));
      const builtin = script && readJson(join(dirname(script), '..', 'config', 'provider', 'zcode-builtin.json'))?.config;
      const providers = personal?.providerConfigRules?.providerRules ?? [];
      for (const provider of providers) {
        const template = builtin?.providerConfigRules?.templateRules?.find((template: any) => template.templateId === provider.templateId);
        const ids = [...(template?.config?.builtinModelIds ?? []), ...(provider.config?.personalModelIds ?? [])];
        for (const model of ids) if (typeof model === 'string') models.push({ id: `${provider.providerId}/${model}`, label: `${provider.providerName ?? provider.providerId} / ${model}` });
      }
      const selection = readJson(join(homedir(), '.zcode', 'cli', 'config.json'))?.modelSelection;
      if (selection?.providerId && selection?.modelId) defaultModel = `${selection.providerId}/${selection.modelId}`;
    }
    if (defaultModel && !models.some(model => model.id === defaultModel)) models.unshift({ id: defaultModel, label: defaultModel });
    return { ...definition, available: !!runtime, executable: runtime?.executable, command: runtime?.command,
      configuredPath: cfg.agents[definition.id]?.executable ?? process.env[`AGENTDESK_${definition.id.toUpperCase()}_PATH`] ?? '',
      detectedPaths: detectedAgentPaths(definition.id).filter(executable => !!findNativeAgent(definition.id,
        { ...cfg, agents: { ...cfg.agents, [definition.id]: { ...cfg.agents[definition.id]!, executable } } })),
      models: [...new Map(models.map(model => [model.id, model])).values()], defaultModel };
  });
}

/** Per-run transport settings never modify the Agent's saved defaults or the prompt. */
export function prepareNativeAgent(options: {
  id: string; cmd: string[]; model?: string | null; cwd: string; runId: number; cfg: AppConfig;
}): { cmd: string[]; env: string[]; cleanup: () => void } {
  const { id, cfg } = options;
  const native = findNativeAgent(id, cfg);
  if (!native) throw new Error(`宿主未发现 ${id} CLI。请安装对应客户端，或配置 agents.${id}.executable。`);
  const files: string[] = [];
  const root = join(cfg.logDir, 'agent-runtime');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, `run-${options.runId}-`));
  const save = (name: string, text: string) => { const path = join(directory, `run-${options.runId}-${name}`); writeFileSync(path, text, { mode: 0o600 }); files.push(path); return path; };
  let cmd = [...native.command, ...options.cmd.slice(1)];
  if (id === 'deepseek') {
    const selected = deepseekSelection();
    if (options.model) {
      const slash = options.model.indexOf('/');
      if (slash > 0) { selected.provider = options.model.slice(0, slash); selected.model = options.model.slice(slash + 1); }
      else selected.model = options.model;
    }
    const patch = save('deepseek.yml', yaml([
      { id: 'credentials', disabled: false }, { id: 'authorization', disabled: false }, { id: 'deepseek-account', disabled: false },
      { id: 'agent-default-model', config: selected },
    ]));
    cmd = [...native.command, '--patch', patch, ...options.cmd.slice(1)];
  } else if (id === 'zcode') {
    const bridge = join(directory, 'zcode-bridge.mjs');
    const code = `const __name=fn=>fn;\n(${zcodeBridgeMain.toString()})().catch(error=>{console.error(error.message);process.exit(1)});\n`;
    if (!existsSync(bridge) || readFileSync(bridge, 'utf8') !== code) writeFileSync(bridge, code, { mode: 0o600 });
    const value = (flag: string) => { const index = options.cmd.indexOf(flag); return index >= 0 ? options.cmd[index + 1] : undefined; };
    const script = native.command.find(path => /zcode\.cjs$/i.test(path));
    const builtinPath = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE || (script && join(dirname(script), '..', 'config', 'provider', 'zcode-builtin.json'));
    const personalPath = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE || join(process.env.ZCODE_DATA_BASE_DIR || homedir(), '.zcode', 'v2', 'provider_config.json');
    if (builtinPath && isFile(builtinPath)) {
      if (!isFile(personalPath)) throw new Error('ZCode 供应商配置不存在，请先在 ZCode 客户端配置供应商并登录。');
      native.env.push(`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=${builtinPath}`, `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE=${personalPath}`);
    }
    const builtin = builtinPath && readJson(builtinPath)?.config;
    let values: string[] | undefined;
    for (const rule of builtin?.modelConfigRules?.modelRules ?? []) {
      try { if (options.model && new RegExp(rule.modelMatch, 'i').test(options.model.split('/').slice(1).join('/')) && rule.config?.optionSpecs?.reasoningLevel?.values) values = rule.config.optionSpecs.reasoningLevel.values; } catch {}
    }
    const reasoningLevel = values?.includes('high') ? 'high' : values?.includes('enabled') ? 'enabled' : values?.at(-1);
    const launch = save('zcode.json', JSON.stringify({ command: native.command, cwd: options.cwd, prompt: value('--prompt'), sessionId: value('--resume'), model: options.model || undefined,
      ...(reasoningLevel && { modelOptions: { reasoningLevel } }) }));
    cmd = [process.execPath, bridge, launch];
  }
  return { cmd, env: native.env, cleanup: () => { for (const path of files) { try { unlinkSync(path); } catch {} } } };
}
