import { app, dialog, Menu, type BrowserWindow } from 'electron';

/** Window operations stay here; environment and task controls live in the dashboard. */
export function installApplicationMenu(window: BrowserWindow, runtime: string, diagnose?: () => void): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '客户端', submenu: [
      { id: 'hide-dashboard', label: '隐藏到托盘', click: () => window.hide() },
      { type: 'separator' },
      { id: 'quit-client', label: '退出客户端', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
    ] },
    // Keep native text-editing accelerators without a redundant visible Edit menu.
    { label: '编辑', visible: false, submenu: [
      { role: 'undo' }, { role: 'redo' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: '视图', submenu: [
      { id: 'reload-dashboard', label: '刷新页面', accelerator: 'CmdOrCtrl+R', click: () => window.reload() },
      { type: 'separator' },
      { label: '放大', role: 'zoomIn' }, { label: '缩小', role: 'zoomOut' }, { label: '恢复默认缩放', role: 'resetZoom' },
      { type: 'separator' }, { label: '全屏', role: 'togglefullscreen' },
      ...(!app.isPackaged ? [{ type: 'separator' as const }, { label: '开发者工具', role: 'toggleDevTools' as const }] : []),
    ] },
    { label: '帮助', submenu: [
      ...(diagnose ? [{ label: '本机诊断（支持后台离线）', click: diagnose }, { type: 'separator' as const }] : []),
      { id: 'about-agentdesk', label: '关于 Runember', click: () => {
        void dialog.showMessageBox(window, { type: 'info', title: '关于 Runember', message: 'Runember',
          detail: `版本：${app.getVersion()}\nElectron：${process.versions.electron}\n当前运行时：${runtime}` });
      } },
    ] },
  ]));
}
