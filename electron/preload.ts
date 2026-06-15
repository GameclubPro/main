import { contextBridge, ipcRenderer } from 'electron';
import type { AuthFormInput, LauncherConfig, LauncherSnapshot } from './launcherCore.js';

const api = {
  platform: process.platform,
  getSnapshot: () => ipcRenderer.invoke('launcher:getSnapshot') as Promise<LauncherSnapshot | null>,
  saveConfig: (partial: Partial<LauncherConfig>) =>
    ipcRenderer.invoke('launcher:saveConfig', partial) as Promise<LauncherSnapshot>,
  registerTestAccount: (input: AuthFormInput) =>
    ipcRenderer.invoke('launcher:registerTestAccount', input) as Promise<LauncherSnapshot>,
  loginTestAccount: (input: AuthFormInput) =>
    ipcRenderer.invoke('launcher:loginTestAccount', input) as Promise<LauncherSnapshot>,
  logoutTestAccount: () => ipcRenderer.invoke('launcher:logoutTestAccount') as Promise<LauncherSnapshot>,
  installLatestVanilla: () => ipcRenderer.invoke('launcher:installLatestVanilla') as Promise<LauncherSnapshot>,
  launchLatestVanilla: () => ipcRenderer.invoke('launcher:launchLatestVanilla') as Promise<LauncherSnapshot>,
  openGameFolder: () => ipcRenderer.invoke('launcher:openGameFolder') as Promise<LauncherSnapshot>,
  openDataFolder: () => ipcRenderer.invoke('launcher:openDataFolder') as Promise<LauncherSnapshot>,
  openLogsFolder: () => ipcRenderer.invoke('launcher:openLogsFolder') as Promise<LauncherSnapshot>,
  reportRendererReady: () => ipcRenderer.send('launcher:rendererReady'),
  reportRendererError: (message: string) => ipcRenderer.send('launcher:rendererError', message),
  onSnapshot: (listener: (snapshot: LauncherSnapshot) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: LauncherSnapshot) => listener(snapshot);
    ipcRenderer.on('launcher:snapshot', wrapped);
    return () => {
      ipcRenderer.removeListener('launcher:snapshot', wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('launcher', api);
