import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from './config.js';
import { runtimeConfig } from './agent-runtime.js';

/** CLI diagnostics share daemon settings without opening or migrating its writable Store. */
export function readRuntimeConfig(cfg: AppConfig): AppConfig {
  const path = join(cfg.dataDir, 'agentdesk.db');
  if (!existsSync(path)) return cfg;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get()) return cfg;
    return runtimeConfig(cfg, { getSetting: key => (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined)?.value });
  } finally { db.close(); }
}
