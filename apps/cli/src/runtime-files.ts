import { existsSync } from 'node:fs';
import { join, posix } from 'node:path';
import { homedir } from 'node:os';

export function runtimeNode(platform: NodeJS.Platform = process.platform): string { return platform === 'win32' ? 'node.exe' : 'node'; }
export function hasRuntime(directory: string, platform: NodeJS.Platform = process.platform): boolean {
  return [runtimeNode(platform), 'desk.mjs', 'daemon.mjs', join('web', 'index.html')].every(file => existsSync(join(directory, file)));
}

/** GUI applications on macOS do not inherit a login shell's PATH. */
export function runtimePath(directory: string, existing = process.env.PATH ?? '', platform: NodeJS.Platform = process.platform, home = homedir()): string {
  const separator = platform === 'win32' ? ';' : ':';
  const standard = platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', posix.join(home, '.local', 'bin'), posix.join(home, '.npm-global', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'] : [];
  return [...new Set([directory, ...existing.split(separator).filter(Boolean), ...standard])].join(separator);
}
