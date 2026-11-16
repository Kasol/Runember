import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, parse } from 'node:path';

interface Folder { name: string; path: string }

export class ProjectFolderError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404) { super(message); }
}

async function locations(): Promise<Folder[]> {
  const defaultRoot = parse(homedir()).root;
  const roots = process.platform === 'win32'
    ? [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => `${letter}:\\`)
    : [defaultRoot];
  const results = await Promise.all(roots.map(async path => {
    const info = await stat(path).catch(() => undefined);
    return info?.isDirectory() ? { name: path, path } : undefined;
  }));
  return [{ name: '用户文件夹', path: homedir() }, ...results.filter((root): root is Folder => root !== undefined)];
}

export async function listProjectFolders(path?: string): Promise<{
  current: Folder | null; parent: string | null; folders: Folder[];
}> {
  if (path === undefined) return { current: null, parent: null, folders: await locations() };
  if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path) ||
      (process.platform === 'win32' && !/^[A-Za-z]:[\\/]/.test(path))) {
    throw new ProjectFolderError('请选择主机磁盘上的绝对目录', 400);
  }
  const directory = normalize(path);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const folders = entries
      .filter(entry => entry.isDirectory() && entry.name !== '.git')
      .map(entry => ({ name: entry.name, path: join(directory, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const parent = dirname(directory);
    return {
      current: { name: basename(directory) || directory, path: directory },
      parent: parent === directory ? null : parent,
      folders,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new ProjectFolderError('找不到该文件夹', 404);
    if (code === 'EACCES' || code === 'EPERM') throw new ProjectFolderError('daemon 无权访问该文件夹', 403);
    throw error;
  }
}
