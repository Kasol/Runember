import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, Tray } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { agentLabel, taskStateLabel, TASK_STATE_LABELS, type TaskView } from '@agentdesk/core';
import { loadConfig, loadLocalEnv, type AppConfig } from '../../daemon/src/config.js';
import { localAddress } from '../../cli/src/launcher.js';
import { installApplicationMenu } from './menu.js';
import { hasRuntime, runtimeNode, runtimePath } from '../../cli/src/runtime-files.js';
import { diagnoseEnvironment, diagnosticExport } from '../../daemon/src/diagnostics.js';

const runFile = promisify(execFile);
let quitting = false;

function supportsRuntime(directory: string): boolean {
  return hasRuntime(directory);
}

async function runtimeDirectory(settings: string): Promise<string | undefined> {
  const index = process.argv.indexOf('--runtime', 1);
  if (index !== -1) {
    const directory = process.argv[index + 1];
    if (!directory || directory.startsWith('--')) throw new Error('--runtime 需要 Runember 运行时目录路径。');
    return resolve(directory);
  }
  if (process.env.AGENTDESK_APP_DIR) return resolve(process.env.AGENTDESK_APP_DIR);
  try {
    const { runtime } = JSON.parse(readFileSync(settings, 'utf8'));
    if (typeof runtime === 'string' && isAbsolute(runtime) && supportsRuntime(runtime)) return runtime;
  } catch { /* 首次启动或设置文件不可用 */ }

  const bundled = join(process.resourcesPath, 'agentdesk');
  if (supportsRuntime(bundled)) return bundled;
  const choice = await dialog.showMessageBox({
    type: 'question',
    title: '选择 Runember 运行时',
    message: '选择包含 desk 启动命令的运行时目录，沿用原有配置和日志路径。',
    buttons: ['选择现有目录', '使用随附运行时', '取消'],
    defaultId: 0,
    cancelId: 2,
  });
  if (choice.response === 2) return;
  if (choice.response === 1) {
    if (supportsRuntime(bundled)) return bundled;
    throw new Error('开发版请通过 --runtime 指定 Runember 运行时目录。');
  }
  const selection = await dialog.showOpenDialog({ title: '选择 Runember 运行时目录', properties: ['openDirectory'] });
  return selection.canceled ? undefined : selection.filePaths[0];
}

async function manageDaemon(runtime: string, command: 'start' | 'stop'): Promise<void> {
  try {
    await runFile(join(runtime, runtimeNode()), [join(runtime, 'desk.mjs'), command, ...(command === 'start' ? ['--no-browser'] : [])], {
      windowsHide: true, timeout: 25_000,
    });
  } catch (error) {
    const failure = error as Error & { stderr?: string };
    throw new Error(failure.stderr?.trim() || failure.message);
  }
}

async function isConfiguredDaemon(cfg: AppConfig, origin: string): Promise<boolean> {
  try {
    const lock = JSON.parse(readFileSync(join(cfg.dataDir, 'daemon.lock'), 'utf8'));
    const response = await fetch(origin + '/healthz', { signal: AbortSignal.timeout(1500) });
    if (!response.ok || typeof lock.instanceId !== 'string') return false;
    const health = await response.json() as { instanceId?: string };
    return health.instanceId === lock.instanceId;
  } catch { return false; }
}

async function revealLogFile(path: unknown): Promise<void> {
  if (typeof path !== 'string' || !isAbsolute(path) || !(await stat(path).catch(() => undefined))?.isFile()) {
    throw new Error('日志文件不存在或不可访问。');
  }
  shell.showItemInFolder(path);
}

async function openDashboard(origin: string, token: string): Promise<BrowserWindow> {
  const dashboardSession = session.fromPartition('agentdesk');
  await dashboardSession.setProxy({ mode: 'direct' });
  const window = new BrowserWindow({
    title: 'Runember',
    width: 1280,
    height: 850,
    show: false,
    webPreferences: {
      session: dashboardSession, nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
    },
  });
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    window.hide();
  });
  const contents = window.webContents;
  if (token) {
    dashboardSession.webRequest.onBeforeSendHeaders({ urls: [`${origin}/api/*`] }, (request, respond) => {
      if (request.webContentsId === contents.id && new URL(request.url).origin === origin) {
        request.requestHeaders['x-agentdesk-token'] = token;
      }
      respond({ requestHeaders: request.requestHeaders });
    });
  }
  contents.on('will-frame-navigate', event => {
    if (new URL(event.url).origin !== origin) event.preventDefault();
  });
  contents.on('will-redirect', event => {
    if (new URL(event.url).origin !== origin) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    const target = new URL(url);
    if (target.origin === 'https://github.com' && /^\/[^/]+\/[^/]+\/pull\/\d+$/.test(target.pathname)) {
      void shell.openExternal(target.href).catch(console.error);
    }
    return { action: 'deny' };
  });
  window.once('ready-to-show', () => window.show());
  await window.loadURL(origin);
  return window;
}

async function startDesktop(): Promise<{ dashboard: BrowserWindow; tray: Tray; dispose(): void } | undefined> {
  const userData = app.getPath('userData');
  const settings = join(userData, 'runtime.json');
  const runtime = await runtimeDirectory(settings);
  if (!runtime) return;
  if (!supportsRuntime(runtime)) throw new Error('此目录缺少完整的 Runember 运行时，请选择匹配当前系统的发布包目录。');

  process.chdir(runtime);
  process.env.AGENTDESK_APP_DIR = runtime;
  process.env.PATH = runtimePath(runtime);
  loadLocalEnv();
  const cfg = loadConfig({ port: process.env.AGENTDESK_PORT ? Number(process.env.AGENTDESK_PORT) : undefined });
  const origin = localAddress(cfg);
  const token = process.env.AGENTDESK_TOKEN ?? cfg.server.token;
  const api = async <T>(path: string): Promise<T> => {
    const res = await fetch(origin + path, {
      headers: token ? { 'x-agentdesk-token': token } : undefined,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error('无法读取后台服务信息。');
    return await res.json() as T;
  };
  const logAction = async (runId?: number) => {
    if (!(await isConfiguredDaemon(cfg, origin))) throw new Error('后台服务未连接。');
    const location = runId === undefined ? '/api/logs/daemon/location' : `/api/runs/${runId}/log/location`;
    const { path } = await api<{ path: string }>(location);
    await revealLogFile(path);
  };

  const localDiagnostics = async () => {
    const report = await diagnoseEnvironment(cfg);
    const choice = await dialog.showMessageBox({ type: 'info', title: 'Runember 本机诊断',
      message: '本机诊断结果', detail: report.findings.map(item => `${item.title}：${item.detail}\n${item.suggestions.join('\n')}`).join('\n\n').slice(0, 12000),
      buttons: ['关闭', '保存诊断报告'], defaultId: 0, cancelId: 0 });
    if (choice.response === 1) {
      const selected = await dialog.showSaveDialog({ title: '保存诊断报告', defaultPath: `runember-diagnostics-${Date.now()}.json` });
      if (selected.filePath && !selected.canceled) await writeFile(selected.filePath, diagnosticExport(report), { flag: 'wx', mode: 0o600 });
    }
  };
  try { await manageDaemon(runtime, 'start'); }
  catch (error) { await localDiagnostics(); throw error; }
  await mkdir(userData, { recursive: true });
  await writeFile(settings + '.tmp', JSON.stringify({ runtime }, null, 2) + '\n');
  await rename(settings + '.tmp', settings);
  const dashboard = await openDashboard(origin, token);
  installApplicationMenu(dashboard, runtime, () => { void localDiagnostics().catch(error => dialog.showErrorBox('Runember 诊断失败', String(error))); });
  ipcMain.handle('agentdesk:open-run-log-location', async (event, runId: unknown) => {
    if (event.sender !== dashboard.webContents || !event.senderFrame?.url || event.senderFrame.parent ||
        new URL(event.senderFrame.url).origin !== origin ||
        typeof runId !== 'number' || !Number.isSafeInteger(runId) || runId < 1) {
      throw new Error('无效的日志定位请求。');
    }
    await logAction(runId);
  });

  const tray = new Tray(join(app.getAppPath(), 'assets', 'tray.png'));
  tray.on('double-click', () => showDashboard(dashboard));
  const reportError = (error: unknown) => dialog.showErrorBox('Runember', error instanceof Error ? error.message : String(error));
  let refreshing = false;
  let managing = false;
  let stopping = false;
  let online = true;
  let taskLine = '正在读取队列…';
  let runningTasks: TaskView[] = [];

  const renderTray = () => {
    const state = stopping ? '后台服务正在停止' : online ? '后台服务在线' : '后台服务离线';
    const command = online ? 'stop' : 'start';
    tray.setToolTip(`Runember · ${state}${online ? ' · ' + taskLine : ''}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开看板', click: () => showDashboard(dashboard) },
      { label: state, enabled: false },
      ...(online ? [{ label: taskLine, enabled: false }] : []),
      ...runningTasks.map(task => ({
        label: `#${task.id} · ${taskStateLabel(task)} · ${agentLabel(task.agent_id)} · ${task.prompt.split('\n', 1)[0]!.slice(0, 60).replace(/&/g, '&&')}`,
        click: () => {
          showDashboard(dashboard);
          void dashboard.loadURL(`${origin}/?task=${task.id}`).catch(reportError);
        },
      })),
      { type: 'separator' },
      { label: '定位 daemon 日志', enabled: online, click: () => void logAction().catch(reportError) },
      { label: stopping ? '等待后台服务停止' : online ? '停止后台服务' : '启动后台服务',
        enabled: !managing && !stopping, click: () => void changeService(command) },
      { label: '退出客户端', click: () => app.quit() },
    ]));
  };

  const refresh = async () => {
    if (refreshing || quitting) return;
    refreshing = true;
    try {
      online = await isConfiguredDaemon(cfg, origin);
      if (stopping && !existsSync(join(cfg.dataDir, 'daemon.lock'))) stopping = false;
      runningTasks = [];
      if (online) {
        try {
          const { tasks } = await api<{ tasks: TaskView[] }>('/api/tasks');
          runningTasks = tasks.filter(task => task.state === 'running');
          taskLine = (['running', 'queued', 'awaiting_confirmation'] as const)
            .map(state => `${TASK_STATE_LABELS[state]} ${tasks.filter(task => task.state === state).length}`).join(' · ');
          const stoppingCount = runningTasks.filter(task => task.stopping).length;
          if (stoppingCount) taskLine += ` · 正在停止 ${stoppingCount}`;
        } catch { taskLine = '暂时无法读取队列'; }
      }
      if (!quitting) renderTray();
    } finally { refreshing = false; }
  };

  const changeService = async (command: 'start' | 'stop') => {
    if (managing || stopping) return;
    managing = true;
    renderTray();
    try {
      await manageDaemon(runtime, command);
      if (command === 'stop') stopping = existsSync(join(cfg.dataDir, 'daemon.lock'));
      if (command === 'start' && !quitting) dashboard.reload();
    } catch (error) { reportError(error); }
    finally { managing = false; await refresh(); }
  };
  renderTray();
  void refresh();
  const timer = setInterval(() => void refresh(), 5000);
  return { dashboard, tray, dispose: () => { clearInterval(timer); if (!tray.isDestroyed()) tray.destroy(); } };
}

function showDashboard(dashboard?: BrowserWindow): void {
  if (!dashboard || dashboard.isDestroyed()) return;
  if (dashboard.isMinimized()) dashboard.restore();
  dashboard.show();
  dashboard.focus();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let desktop: Awaited<ReturnType<typeof startDesktop>>;
  app.on('second-instance', () => showDashboard(desktop?.dashboard));
  app.on('before-quit', () => {
    quitting = true;
    desktop?.dispose();
  });
  void app.whenReady().then(async () => {
    desktop = await startDesktop();
    if (!desktop) app.quit();
  }).catch(error => {
    dialog.showErrorBox('Runember 启动失败', error instanceof Error ? error.message : String(error));
    app.quit();
  });
}
