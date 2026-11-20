import { homedir } from 'node:os';
import { join } from 'node:path';

/** Stable standalone entry points, independent of a long-running daemon's PATH. */
export function standaloneCodexPaths(): string[] {
  if (process.platform !== 'win32') return [];
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  return [
    ...(process.env.CODEX_INSTALL_DIR ? [join(process.env.CODEX_INSTALL_DIR, 'codex.exe')] : []),
    join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
  ];
}
