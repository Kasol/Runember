/**
 * 平台兼容性检测（isolation 模式注册时的守门员）。
 *
 * 检测目标：项目内是否有 Linux 容器无法加载的组件。
 * 策略（启发式组合，覆盖 95% 场景，不做 PE 魔数全扫）：
 *  ① git 追踪文件中的 Windows 原生扩展名（.dll/.exe/.sys/.ocx/.lib/.pdb）
 *  ② package.json 依赖里的原生模块（node-gyp/@{org}/平台包模式）
 *
 * 命中即拒绝注册并提示切换 capability 模式。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const pExecFile = promisify(execFile);

const WIN_NATIVE_EXT = /\.(dll|exe|sys|ocx|lib|pdb|mui)$/i;
const NATIVE_MODULE_RE = /node-gyp|\.node$|-(win32|darwin|linux)-x64|@resvg|^fsevents$|^esbuild$|^rollup(-|$)/i;

export interface PlatformCheckResult {
  ok: boolean;
  /** 命中的证据（前 N 条），用于报错信息 */
  evidence: string[];
  summary: string;
}

export async function checkIsolationCompatibility(projectPath: string): Promise<PlatformCheckResult> {
  const evidence: string[] = [];

  // ① git 追踪文件扫描（限 30s 超时；非 git 仓库跳过此层）
  if (existsSync(join(projectPath, '.git'))) {
    try {
      const { stdout } = await pExecFile('git', ['ls-files'], {
        cwd: projectPath, timeout: 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      });
      const winFiles = stdout.split('\n').filter(f => WIN_NATIVE_EXT.test(f.trim()));
      if (winFiles.length) {
        evidence.push(`Windows 原生二进制 ${winFiles.length} 个（如 ${winFiles.slice(0, 3).map(f => f.split('/').pop()).join('、')}）`);
      }
    } catch { /* git 超时/失败则跳过此层，靠 ② */ }
  }

  // ② 依赖声明扫描（根 + packages/*/package.json）
  const pkgPaths = [join(projectPath, 'package.json'),
    ...expandWorkspaces(projectPath)];
  for (const pkgPath of pkgPaths) {
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
      for (const name of Object.keys(deps ?? {})) {
        if (NATIVE_MODULE_RE.test(name) && evidence.length < 8) {
          evidence.push(`原生模块依赖: ${name}`);
        }
      }
    } catch { /* 损坏 json 忽略 */ }
  }

  return evidence.length
    ? { ok: false, evidence, summary: `检测到 Linux 容器无法加载的 Windows 原生组件：${evidence.slice(0, 3).join('；')}${evidence.length > 3 ? ` 等 ${evidence.length} 项` : ''}` }
    : { ok: true, evidence: [], summary: '未检测到平台绑定组件' };
}

// 展开 npm workspaces 的 packages 子目录 package.json（宽松匹配，无 workspaces 时返回空）
function expandWorkspaces(projectPath: string): string[] {
  const out: string[] = [];
  try {
    const root = JSON.parse(readFileSync(join(projectPath, 'package.json'), 'utf8'));
    const patterns: string[] = root.workspaces ?? [];
    for (const pat of patterns) {
      if (!pat.endsWith('/*')) continue;
      const base = join(projectPath, pat.replace(/\/\*$/, ''));
      if (!existsSync(base)) continue;
      for (const name of readdirSafe(base)) {
        const p = join(base, name, 'package.json');
        if (existsSync(p)) out.push(p);
      }
    }
  } catch { /* 无 workspaces */ }
  return out;
}

function readdirSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}
