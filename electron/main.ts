import path from 'node:path';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { app, BrowserWindow, crashReporter, dialog, ipcMain, shell } from 'electron';
import {
  compareVersions,
  downloadFile,
  fetchJson,
  LauncherService,
  type LauncherConfig,
  type LauncherDeviceStart,
  type LauncherSnapshot,
} from './launcherCore.js';

let mainWindow: Electron.BrowserWindow | null = null;
let launcherService: LauncherService | null = null;
let startupErrorShown = false;
let earlyPathSetupError: unknown = null;
let dataRootFallbackNote = '';
let dataRootFallbackWarning = '';

const initialUserDataPath = app.getPath('userData');
const portableRoot = process.platform === 'win32' ? process.env.PORTABLE_EXECUTABLE_DIR : undefined;
const installedDataRootPath = () =>
  process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'FlexCraft')
    : path.join(initialUserDataPath, 'flexcraft');
const preferredDataRootPath = () => (portableRoot ? path.join(portableRoot, 'FlexCraftData') : installedDataRootPath());
let activeDataRootPath = preferredDataRootPath();
const dataRootPath = () => activeDataRootPath;
const logsDirPath = () => path.join(dataRootPath(), 'logs');
const startupLogPath = () => path.join(logsDirPath(), 'launcher-startup.log');
const chromiumLogPath = () => path.join(logsDirPath(), 'chromium-debug.log');
const sessionDataPath = () => path.join(dataRootPath(), 'electron-session');
const crashDumpsPath = () => path.join(dataRootPath(), 'crashes');
const maxLogBytes = 10 * 1024 * 1024;
const maxRotatedLogs = 4;
const maxCrashDumpAgeMs = 30 * 24 * 60 * 60 * 1000;
const maxCrashDumps = 20;
const launcherUpdateManifestUrls = [
  'https://flex-craft.ru/downloads/latest.json',
  'https://www.flex-craft.ru/downloads/latest.json',
] as const;

interface LauncherUpdateManifest {
  version?: string;
  installer?: {
    url?: string;
    fallbackUrls?: string[];
    file?: string;
    sha1?: string;
    sha256?: string;
    size?: number;
    silentArgs?: string[];
  };
}

const ensureWritableDirectory = (targetPath: string) => {
  mkdirSync(targetPath, { recursive: true });
  const probePath = path.join(targetPath, `.flexcraft-write-test-${process.pid}-${Date.now()}.tmp`);
  const renamedPath = `${probePath}.renamed`;
  writeFileSync(probePath, 'ok', 'utf8');
  renameSync(probePath, renamedPath);
  unlinkSync(renamedPath);
};

const tryStat = (targetPath: string) => {
  try {
    return statSync(targetPath);
  } catch {
    return null;
  }
};

const rotateLogIfLarge = (logPath: string) => {
  try {
    const logStat = tryStat(logPath);
    if (!logStat?.isFile() || logStat.size <= maxLogBytes) {
      return;
    }

    for (let index = maxRotatedLogs; index >= 1; index -= 1) {
      const currentPath = `${logPath}.${index}`;
      const nextPath = `${logPath}.${index + 1}`;
      if (!tryStat(currentPath)?.isFile()) {
        continue;
      }

      if (index === maxRotatedLogs) {
        unlinkSync(currentPath);
      } else {
        renameSync(currentPath, nextPath);
      }
    }

    renameSync(logPath, `${logPath}.1`);
  } catch {
    // Log cleanup is best-effort and must never block startup.
  }
};

const cleanupDiagnostics = () => {
  try {
    for (const entry of readdirSync(logsDirPath(), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.log')) {
        rotateLogIfLarge(path.join(logsDirPath(), entry.name));
      }
    }
  } catch {
    // Best-effort diagnostics cleanup.
  }

  try {
    const now = Date.now();
    const crashFiles = readdirSync(crashDumpsPath(), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const filePath = path.join(crashDumpsPath(), entry.name);
        const fileStat = tryStat(filePath);
        return fileStat ? { filePath, mtimeMs: fileStat.mtimeMs } : null;
      })
      .filter((entry): entry is { filePath: string; mtimeMs: number } => Boolean(entry))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);

    crashFiles.forEach((entry, index) => {
      if (index >= maxCrashDumps || now - entry.mtimeMs > maxCrashDumpAgeMs) {
        rmSync(entry.filePath, { force: true });
      }
    });
  } catch {
    // Best-effort diagnostics cleanup.
  }
};

const prepareDataRoot = () => {
  ensureWritableDirectory(dataRootPath());
  ensureWritableDirectory(logsDirPath());
  ensureWritableDirectory(sessionDataPath());
  ensureWritableDirectory(crashDumpsPath());
  cleanupDiagnostics();
};

try {
  try {
    prepareDataRoot();
  } catch (error) {
    if (!portableRoot) {
      throw error;
    }

    const failedPortablePath = dataRootPath();
    activeDataRootPath = installedDataRootPath();
    prepareDataRoot();
    dataRootFallbackNote = `Portable data root is not writable (${failedPortablePath}); using ${dataRootPath()} instead.`;
    dataRootFallbackWarning = `Portable-папка рядом с лаунчером недоступна для записи. Данные сохранены в ${dataRootPath()}.`;
  }

  app.setPath('userData', dataRootPath());
  app.setPath('sessionData', sessionDataPath());
  app.setPath('crashDumps', crashDumpsPath());
  app.setAppLogsPath(logsDirPath());
  crashReporter.start({
    uploadToServer: false,
    productName: 'FlexCraft',
    companyName: 'FlexCraft',
    globalExtra: {
      version: app.getVersion(),
      dataRoot: dataRootPath(),
    },
  });
} catch (error) {
  earlyPathSetupError = error;
}

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('enable-logging', 'file');
app.commandLine.appendSwitch('log-file', chromiumLogPath());
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('disable-zero-copy');
app.commandLine.appendSwitch('disable-direct-composition');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,DirectComposition,Vulkan');

const formatStartupError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
};

const appendStartupLog = (line: string) => {
  try {
    const logPath = startupLogPath();
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // Startup diagnostics must never become the reason the app fails to open.
  }
};

const isNavigationAbort = (error: unknown): boolean => {
  const message = formatStartupError(error);
  return message.includes('ERR_ABORTED') || message.includes('(-3)');
};

const handleNavigationError = (error: unknown) => {
  if (isNavigationAbort(error)) {
    appendStartupLog(`Ignored navigation abort: ${formatStartupError(error)}`);
    return;
  }

  showStartupError(error);
};

const fatalRendererGoneReasons = new Set(['crashed', 'oom', 'launch-failed', 'integrity-failure']);

const showStartupError = (error: unknown) => {
  const message = formatStartupError(error);
  const logPath = startupLogPath();

  appendStartupLog(`Fatal startup error: ${message}`);

  if (startupErrorShown) {
    return;
  }

  startupErrorShown = true;
  dialog.showErrorBox(
    'FlexCraft не запустился',
    `Лаунчер не смог завершить запуск.\n\n${message}\n\nЛог: ${logPath}`,
  );
};

process.on('uncaughtException', (error) => {
  showStartupError(error);
});

process.on('unhandledRejection', (reason) => {
  showStartupError(reason);
});

const broadcastSnapshot = (snapshot: LauncherSnapshot) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send('launcher:snapshot', snapshot);
};

const normalizeUpdateDigest = (value: unknown, length: number): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const digest = value.trim().toLowerCase();
  return new RegExp(`^[a-f0-9]{${length}}$`).test(digest) ? digest : undefined;
};

const normalizeUpdateSize = (value: unknown): number | undefined => {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? Math.floor(size) : undefined;
};

const normalizeInstallerFileName = (value: unknown): string => {
  if (typeof value !== 'string') {
    return 'FlexCraft-Launcher-update.exe';
  }

  const fileName = path.basename(value.trim());
  return fileName.toLowerCase().endsWith('.exe') ? fileName : 'FlexCraft-Launcher-update.exe';
};

const normalizeSilentArgs = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return ['/S'];
  }

  const args = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 12);

  return args.length > 0 ? args : ['/S'];
};

const showLauncherMessageBox = async (options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> => {
  const parentWindow = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null;
  return parentWindow ? dialog.showMessageBox(parentWindow, options) : dialog.showMessageBox(options);
};

const runLauncherUpdateCheck = async (): Promise<boolean> => {
  if (process.platform !== 'win32') {
    return false;
  }

  let manifest: LauncherUpdateManifest;
  try {
    manifest = await fetchJson<LauncherUpdateManifest>(launcherUpdateManifestUrls);
  } catch (error) {
    appendStartupLog(`Launcher update check failed: ${formatStartupError(error)}`);
    return false;
  }

  const latestVersion = typeof manifest.version === 'string' ? manifest.version.trim() : '';
  const currentVersion = app.getVersion();
  if (!latestVersion || compareVersions(currentVersion, latestVersion) >= 0) {
    appendStartupLog(`Launcher is up to date: ${currentVersion}.`);
    return false;
  }

  const installerUrl = manifest.installer?.url?.trim();
  if (!installerUrl || !/^https:\/\//i.test(installerUrl)) {
    appendStartupLog(`Launcher update ${latestVersion} ignored: installer URL is missing.`);
    return false;
  }

  const response = await showLauncherMessageBox({
    type: 'info',
    title: 'Доступно обновление FlexCraft',
    message: `Доступна новая версия FlexCraft ${latestVersion}`,
    detail: `Сейчас установлена версия ${currentVersion}. Нажмите «Обновить», и лаунчер сам скачает и установит новую версию.`,
    buttons: ['Обновить'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });

  if (response.response !== 0) {
    appendStartupLog(`Launcher update ${latestVersion} was not accepted by the user.`);
    return false;
  }

  const fileName = normalizeInstallerFileName(manifest.installer?.file);
  const destination = path.join(dataRootPath(), 'cache', 'launcher-updates', `${latestVersion}-${fileName}`);
  const fallbackUrls = Array.isArray(manifest.installer?.fallbackUrls)
    ? manifest.installer.fallbackUrls.filter((url): url is string => typeof url === 'string' && /^https:\/\//i.test(url.trim())).map((url) => url.trim())
    : [];

  try {
    appendStartupLog(`Downloading launcher update ${latestVersion} to ${destination}.`);
    await downloadFile({
      url: installerUrl,
      urls: fallbackUrls,
      destination,
      expectedSha1: normalizeUpdateDigest(manifest.installer?.sha1, 40),
      expectedSha256: normalizeUpdateDigest(manifest.installer?.sha256, 64),
      expectedSize: normalizeUpdateSize(manifest.installer?.size),
      minimumSize: 1024 * 1024,
    });

    appendStartupLog(`Starting launcher update installer: ${destination}`);
    const installer = spawn(destination, normalizeSilentArgs(manifest.installer?.silentArgs), {
      detached: true,
      stdio: 'ignore',
    });
    installer.unref();
    app.quit();
    return true;
  } catch (error) {
    appendStartupLog(`Launcher update ${latestVersion} failed: ${formatStartupError(error)}`);
    await showLauncherMessageBox({
      type: 'error',
      title: 'Не удалось обновить FlexCraft',
      message: 'Автоматическое обновление не завершилось.',
      detail: formatStartupError(error),
      buttons: ['ОК'],
      noLink: true,
    });
    return false;
  }
};

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1160,
    height: 760,
    minWidth: 860,
    minHeight: 620,
    title: 'FlexCraft',
    backgroundColor: '#0b1014',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  let rendererReady = false;
  let rendererReadyTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRendererReadyTimer = () => {
    if (rendererReadyTimer) {
      clearTimeout(rendererReadyTimer);
      rendererReadyTimer = null;
    }
  };

  const startRendererReadyTimer = () => {
    clearRendererReadyTimer();
    rendererReadyTimer = setTimeout(() => {
      if (rendererReady || window.isDestroyed()) {
        return;
      }

      const message = 'Renderer loaded but did not report readiness.';
      appendStartupLog(message);
      if (!window.isVisible()) {
        window.show();
      }
      showStartupError(new Error('Интерфейс лаунчера загрузился не полностью. Попробуйте перезапустить лаунчер и отправьте launcher-startup.log разработчику.'));
    }, 12000);
  };

  const handleRendererReady = (event: Electron.IpcMainEvent) => {
    if (event.sender !== window.webContents) {
      return;
    }

    rendererReady = true;
    clearRendererReadyTimer();
    appendStartupLog('Renderer reported ready.');
    if (!window.isVisible()) {
      window.show();
    }
    if (launcherService) {
      broadcastSnapshot(launcherService.getSnapshot());
    }
  };

  ipcMain.on('launcher:rendererReady', handleRendererReady);

  window.webContents.on('did-start-loading', () => {
    appendStartupLog('Renderer loading started.');
  });

  window.webContents.on('did-finish-load', () => {
    appendStartupLog('Renderer loaded.');
    startRendererReadyTimer();
  });

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    showStartupError(new Error(`Preload failed (${preloadPath}): ${formatStartupError(error)}`));
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    const message = `Renderer failed to load ${validatedUrl}: ${errorCode} ${errorDescription}`;
    appendStartupLog(message);

    if (errorCode === -3) {
      appendStartupLog('Renderer load failure ignored as a navigation abort.');
      return;
    }

    showStartupError(new Error(message));
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    const message = `Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`;
    appendStartupLog(message);
    if (fatalRendererGoneReasons.has(details.reason)) {
      showStartupError(new Error(message));
    }
  });

  window.on('closed', () => {
    clearRendererReadyTimer();
    ipcMain.removeListener('launcher:rendererReady', handleRendererReady);
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    window.loadURL(devServerUrl).catch(handleNavigationError);
    window.webContents.openDevTools({ mode: 'detach' });
  } else {
    const rendererPath = path.join(__dirname, '../dist/index.html');
    appendStartupLog(`Loading renderer from ${rendererPath}`);
    window.loadFile(rendererPath).catch(handleNavigationError);
  }

  return window;
};

app.on('child-process-gone', (_event, details) => {
  appendStartupLog(`Child process gone: type=${details.type}, reason=${details.reason}, exitCode=${details.exitCode}`);
});

const requireService = () => {
  if (!launcherService) {
    throw new Error('Лаунчер еще запускается.');
  }

  return launcherService;
};

const registerIpc = () => {
  ipcMain.on('launcher:rendererError', (_event, message: string) => {
    appendStartupLog(`Renderer error: ${message}`);
  });
  ipcMain.handle('launcher:getSnapshot', async () => requireService().getSnapshot());
  ipcMain.handle('launcher:saveConfig', async (_event, partial: Partial<LauncherConfig>) => requireService().saveConfig(partial));
  ipcMain.handle('launcher:logoutAccount', async () => requireService().logoutAccount());
  ipcMain.handle('launcher:startAccountLink', async () => requireService().startLauncherAccountLink() as Promise<LauncherDeviceStart>);
  ipcMain.handle('launcher:completeAccountLink', async (_event, deviceCode: string) => requireService().completeLauncherAccountLink(deviceCode));
  ipcMain.handle('launcher:openExternal', async (_event, url: string) => {
    if (!/^https:\/\/(?:www\.)?flex-craft\.ru\//i.test(url)) {
      throw new Error('External URL is not allowed.');
    }

    await shell.openExternal(url);
  });
  ipcMain.handle('launcher:installLatestVanilla', async () => {
    const service = requireService();
    await service.installLatestVanilla();
    return service.getSnapshot();
  });
  ipcMain.handle('launcher:launchLatestVanilla', async () => {
    const service = requireService();
    if (await runLauncherUpdateCheck()) {
      return service.getSnapshot();
    }

    await service.launchLatestVanilla();
    return service.getSnapshot();
  });
  ipcMain.handle('launcher:openGameFolder', async () => {
    const service = requireService();
    await service.openGameFolder();
    const snapshot = service.getSnapshot();
    await shell.openPath(snapshot.status.gameDir);
    return snapshot;
  });
  ipcMain.handle('launcher:openDataFolder', async () => {
    const service = requireService();
    await service.openDataFolder();
    const snapshot = service.getSnapshot();
    await shell.openPath(snapshot.status.dataRoot);
    return snapshot;
  });
  ipcMain.handle('launcher:openLogsFolder', async () => {
    const service = requireService();
    await service.openLogsFolder();
    const snapshot = service.getSnapshot();
    await shell.openPath(snapshot.status.logsDir);
    return snapshot;
  });
};

app.whenReady().then(async () => {
  if (earlyPathSetupError) {
    showStartupError(new Error(`Не удалось подготовить папку данных ${dataRootPath()}: ${formatStartupError(earlyPathSetupError)}`));
    app.quit();
    return;
  }

  appendStartupLog(`Starting FlexCraft ${app.getVersion()} on ${process.platform}/${process.arch}.`);
  appendStartupLog(`Data root: ${dataRootPath()}`);
  if (dataRootFallbackNote) {
    appendStartupLog(dataRootFallbackNote);
  }
  appendStartupLog(`Chromium log: ${chromiumLogPath()}`);
  appendStartupLog(`GPU feature status: ${JSON.stringify(app.getGPUFeatureStatus())}`);

  launcherService = new LauncherService({
    userDataDir: dataRootPath(),
    launcherName: 'flexcraft-launcher',
    launcherVersion: app.getVersion(),
    startupWarning: dataRootFallbackWarning,
    emitSnapshot: broadcastSnapshot,
  });

  registerIpc();
  mainWindow = createWindow();

  try {
    if (await runLauncherUpdateCheck()) {
      return;
    }

    appendStartupLog('Initializing launcher service.');
    await launcherService.initialize();
    appendStartupLog('Launcher service initialized.');
    broadcastSnapshot(launcherService.getSnapshot());
    void runLauncherUpdateCheck().catch((error) => {
      appendStartupLog(`Launcher update check crashed: ${formatStartupError(error)}`);
    });
  } catch (error) {
    showStartupError(error);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      if (launcherService) {
        broadcastSnapshot(launcherService.getSnapshot());
      }
    }
  });
}).catch((error) => {
  showStartupError(error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
