import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('agentdeskDesktop', {
  openRunLogLocation: (runId: number): Promise<void> => ipcRenderer.invoke('agentdesk:open-run-log-location', runId),
});
