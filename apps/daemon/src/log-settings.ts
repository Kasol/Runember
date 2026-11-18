import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import type { AppConfig } from './config.js';
import type { Store } from './store.js';

export function savedLogDirectory(dataDir: string): string | undefined {
  const file = join(dataDir, 'agentdesk.db');
  if (!existsSync(file)) return;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get()) return;
    return (db.prepare("SELECT value FROM settings WHERE key='storage.logDir'").get() as { value: string } | undefined)?.value;
  } finally { db.close(); }
}

export function logSettings(cfg: AppConfig, store: Store) {
  const saved = store.getSetting('storage.logDir');
  const configuredDir = saved === undefined ? cfg.logDir : resolve(cfg.dataDir, saved);
  return { currentDir: cfg.logDir, configuredDir, dataDir: resolve(cfg.dataDir),
    restartRequired: resolve(configuredDir) !== resolve(cfg.logDir) };
}

export function validateLogDirectory(value: string): string {
  const directory = value.trim();
  if (!directory) return '';
  if (!isAbsolute(directory) || directory.includes('\0') || (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(directory))) {
    throw new Error('请选择主机磁盘上的绝对目录。');
  }
  mkdirSync(directory, { recursive: true });
  const probe = join(directory, `.agentdesk-write-check-${randomUUID()}`);
  const fd = openSync(probe, 'wx', 0o600);
  try { closeSync(fd); } finally { unlinkSync(probe); }
  return resolve(directory);
}
