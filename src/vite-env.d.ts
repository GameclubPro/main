/// <reference types="vite/client" />

interface LauncherConfig {
  username: string;
  serverAddress: string;
  javaExecutable: string;
  useBundledJava: boolean;
  minMemoryMb: number;
  maxMemoryMb: number;
  preferredVersion: string;
}

interface AuthSession {
  accountId: string;
  login: string;
  username: string;
  source?: 'flexcraft';
}

interface LauncherDeviceStart {
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

interface LauncherProgress {
  stage: string;
  current: number;
  total: number;
  percent: number;
  detail: string;
}

type JavaSource = 'bundled' | 'custom' | 'system' | 'missing';

interface LauncherStatus {
  versionId: string;
  latestRelease: string;
  gameDir: string;
  installed: boolean;
  javaReady: boolean;
  javaSource: JavaSource;
  javaPath: string;
  isBusy: boolean;
  isLaunching: boolean;
  statusLine: string;
  progress: LauncherProgress | null;
  warning: string | null;
  lastError: string | null;
  dataRoot: string;
  logsDir: string;
  logs: string[];
}

interface LauncherSnapshot {
  config: LauncherConfig;
  status: LauncherStatus;
  session: AuthSession | null;
}

interface Window {
  launcher?: {
    platform: NodeJS.Platform;
    getSnapshot: () => Promise<LauncherSnapshot | null>;
    saveConfig: (partial: Partial<LauncherConfig>) => Promise<LauncherSnapshot>;
    logoutAccount: () => Promise<LauncherSnapshot>;
    startAccountLink: () => Promise<LauncherDeviceStart>;
    completeAccountLink: (deviceCode: string) => Promise<LauncherSnapshot>;
    openExternal: (url: string) => Promise<void>;
    installLatestVanilla: () => Promise<LauncherSnapshot>;
    launchLatestVanilla: () => Promise<LauncherSnapshot>;
    openGameFolder: () => Promise<LauncherSnapshot>;
    openDataFolder: () => Promise<LauncherSnapshot>;
    openLogsFolder: () => Promise<LauncherSnapshot>;
    reportRendererReady?: () => void;
    reportRendererError?: (message: string) => void;
    onSnapshot: (listener: (snapshot: LauncherSnapshot) => void) => () => void;
  };
}
