import {
  Check,
  ChevronDown,
  Cpu,
  FileText,
  FolderOpen,
  Gamepad2,
  HardDrive,
  LoaderCircle,
  LogOut,
  Play,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
  UserPlus,
  UserRound,
} from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode, useEffect, useMemo, useState } from 'react';
import { LAUNCHER_VERSION } from '../launcherInfo';
import { LandingPage } from './landingPage';

const fallbackSnapshot: LauncherSnapshot = {
  config: {
    username: 'FlexCraft',
    serverAddress: 'flex-craft.ru:25565',
    javaExecutable: '',
    useBundledJava: true,
    minMemoryMb: 2048,
    maxMemoryMb: 4096,
    preferredVersion: 'fabric-loader-0.19.2-26.1.2',
  },
  status: {
    versionId: 'fabric-loader-0.19.2-26.1.2',
    latestRelease: 'fabric-loader-0.19.2-26.1.2',
    gameDir: '',
    installed: false,
    javaReady: false,
    javaSource: 'missing',
    javaPath: '',
    isBusy: false,
    isLaunching: false,
    statusLine: 'Лаунчер загружается...',
    progress: null,
    warning: null,
    lastError: null,
    dataRoot: '',
    logsDir: '',
    logs: [],
  },
  accounts: [],
  session: null,
};

function formatPercent(value: number): string {
  return `${Math.max(0, Math.min(100, value))}%`;
}

function sourceLabel(source: JavaSource): string {
  switch (source) {
    case 'bundled':
      return 'Встроенная Java';
    case 'custom':
      return 'Своя Java';
    case 'system':
      return 'Системная Java';
    default:
      return 'Java будет подготовлена';
  }
}

function shortVersion(version: string): string {
  return version.replace('fabric-loader-', 'Fabric ');
}

function formatUiError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function launchState(snapshot: LauncherSnapshot): string {
  if (snapshot.status.isLaunching) {
    return 'Игра запускается';
  }

  if (snapshot.status.isBusy) {
    return 'Подготовка клиента';
  }

  if (!snapshot.session) {
    return 'Войдите в профиль';
  }

  if (!snapshot.status.installed) {
    return 'Нужно подготовить файлы';
  }

  return 'Готов к игре';
}

export function App() {
  return (
    <RendererErrorBoundary>
      {window.launcher ? <LauncherApp /> : <LandingPage />}
    </RendererErrorBoundary>
  );
}

class RendererErrorBoundary extends Component<{ children: ReactNode }, { message: string }> {
  state = { message: '' };

  static getDerivedStateFromError(error: Error) {
    return { message: error.stack ?? error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const message = `${error.stack ?? error.message}\n${info.componentStack}`;
    window.launcher?.reportRendererError?.(message);
  }

  render() {
    if (this.state.message) {
      return (
        <main className="rendererError">
          <h1>FlexCraft не открыл интерфейс</h1>
          <p>Отправьте этот текст или файл launcher-startup.log разработчику.</p>
          <pre>{this.state.message}</pre>
        </main>
      );
    }

    return this.props.children;
  }
}

function LauncherApp() {
  const [snapshot, setSnapshot] = useState<LauncherSnapshot>(fallbackSnapshot);
  const [form, setForm] = useState<LauncherConfig>(fallbackSnapshot.config);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authForm, setAuthForm] = useState<AuthFormInput>({ login: '', username: '', password: '' });
  const [uiMessage, setUiMessage] = useState<string>('');
  const [savePending, setSavePending] = useState(false);
  const [authPending, setAuthPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const launcher = window.launcher;
    if (!launcher) {
      setUiMessage('Приложение запущено без доступа к лаунчеру.');
      return;
    }

    let mounted = true;
    void launcher
      .getSnapshot()
      .then((nextSnapshot) => {
        if (!mounted || !nextSnapshot) {
          return;
        }

        setSnapshot(nextSnapshot);
        setForm(nextSnapshot.config);
        if (!nextSnapshot.session && nextSnapshot.accounts.length === 0) {
          setAuthMode('register');
        }
      })
      .catch((error) => {
        if (mounted) {
          setUiMessage(formatUiError(error));
        }
      });

    const unsubscribe = launcher.onSnapshot((nextSnapshot) => {
      if (!mounted) {
        return;
      }

      setSnapshot(nextSnapshot);
      setForm((current) => ({ ...current, ...nextSnapshot.config }));
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const busy = snapshot.status.isBusy;
  const hasSession = Boolean(snapshot.session);
  const launchDisabled = busy || snapshot.status.isLaunching || !hasSession;
  const installDisabled = busy || !hasSession;
  const authSubmitDisabled = authPending || busy || !authForm.login.trim() || !authForm.password.trim();
  const mainStatus = launchState(snapshot);
  const statusText = snapshot.status.progress?.detail ?? snapshot.status.statusLine;
  const serverValue = form.serverAddress.trim() || 'flex-craft.ru:25565';
  const accountTitle = snapshot.session?.username ?? 'Гость';
  const accountSubtitle = snapshot.session ? snapshot.session.login : 'Профиль не выбран';
  const progressWidth = useMemo(
    () => formatPercent(snapshot.status.progress?.percent ?? (snapshot.status.installed ? 100 : 0)),
    [snapshot.status.installed, snapshot.status.progress],
  );

  const saveConfig = async (partial?: Partial<LauncherConfig>) => {
    if (!window.launcher) {
      return;
    }

    setSavePending(true);
    try {
      const nextSnapshot = await window.launcher.saveConfig(partial ?? form);
      setSnapshot(nextSnapshot);
      setForm(nextSnapshot.config);
    } catch (error) {
      setUiMessage(formatUiError(error));
    } finally {
      setSavePending(false);
    }
  };

  const handleAuthSubmit = async () => {
    if (!window.launcher) {
      return;
    }

    setAuthPending(true);
    try {
      const nextSnapshot =
        authMode === 'register'
          ? await window.launcher.registerTestAccount(authForm)
          : await window.launcher.loginTestAccount(authForm);
      setSnapshot(nextSnapshot);
      setForm(nextSnapshot.config);
      setUiMessage(authMode === 'register' ? 'Профиль создан.' : 'Вход выполнен.');
      setAuthMode('login');
      setAuthForm({ login: '', username: '', password: '' });
    } catch (error) {
      setUiMessage(formatUiError(error));
    } finally {
      setAuthPending(false);
    }
  };

  const handleLogout = async () => {
    if (!window.launcher) {
      return;
    }

    const nextSnapshot = await window.launcher.logoutTestAccount();
    setSnapshot(nextSnapshot);
    setUiMessage('Вы вышли из профиля.');
  };

  const handleInstall = async () => {
    if (!window.launcher) {
      return;
    }

    setUiMessage('Подготавливаем клиент...');
    await saveConfig();
    try {
      const nextSnapshot = await window.launcher.installLatestVanilla();
      setSnapshot(nextSnapshot);
      setUiMessage('Клиент готов.');
    } catch (error) {
      setUiMessage(formatUiError(error));
    }
  };

  const handleLaunch = async () => {
    if (!window.launcher) {
      return;
    }

    setUiMessage('Запускаем Minecraft...');
    await saveConfig();
    try {
      const nextSnapshot = await window.launcher.launchLatestVanilla();
      setSnapshot(nextSnapshot);
      setUiMessage('Minecraft запускается.');
    } catch (error) {
      setUiMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const openGameFolder = async () => {
    if (!window.launcher) {
      return;
    }

    await window.launcher.openGameFolder();
  };

  const openDataFolder = async () => {
    if (!window.launcher) {
      return;
    }

    await window.launcher.openDataFolder();
  };

  const openLogsFolder = async () => {
    if (!window.launcher) {
      return;
    }

    await window.launcher.openLogsFolder();
  };

  return (
    <main className="launcherShell">
      <header className="launcherHeader">
        <div className="launcherBrand">
          <span className="brandIcon"><Gamepad2 size={20} /></span>
          <div>
            <strong>FlexCraft</strong>
            <small>версия {LAUNCHER_VERSION}</small>
          </div>
        </div>

        <div className="launcherHeaderActions">
          <button className="headerButton" type="button" onClick={openGameFolder}>
            <FolderOpen size={17} />
            Папка игры
          </button>
          <button className="headerButton" type="button" onClick={openDataFolder}>
            <HardDrive size={17} />
            Данные
          </button>
          <button className="headerButton" type="button" onClick={openLogsFolder}>
            <FileText size={17} />
            Логи
          </button>
        </div>
      </header>

      <section className="launcherLayout">
        <aside className="accountPane" aria-label="Профиль игрока">
          <div className="profileSummary">
            <span className="avatarBubble"><UserRound size={24} /></span>
            <div>
              <strong>{accountTitle}</strong>
              <small>{accountSubtitle}</small>
            </div>
          </div>

          {snapshot.session ? (
            <button className="plainButton" type="button" onClick={handleLogout}>
              <LogOut size={16} />
              Выйти
            </button>
          ) : null}

          {!snapshot.session ? (
            <section className="authBox">
              <div className="segmentedControl" role="tablist" aria-label="Профиль">
                <button
                  type="button"
                  className={authMode === 'login' ? 'active' : ''}
                  onClick={() => setAuthMode('login')}
                >
                  Войти
                </button>
                <button
                  type="button"
                  className={authMode === 'register' ? 'active' : ''}
                  onClick={() => setAuthMode('register')}
                >
                  Создать
                </button>
              </div>

              <label className="field">
                <span><ShieldCheck size={16} /> Логин</span>
                <input
                  value={authForm.login}
                  onChange={(event) => setAuthForm((current) => ({ ...current, login: event.target.value }))}
                  placeholder="ivan"
                />
              </label>

              {authMode === 'register' ? (
                <label className="field">
                  <span><UserRound size={16} /> Ник</span>
                  <input
                    value={authForm.username ?? ''}
                    maxLength={16}
                    onChange={(event) => setAuthForm((current) => ({ ...current, username: event.target.value }))}
                    placeholder="Ivan"
                  />
                </label>
              ) : null}

              <label className="field">
                <span>Пароль</span>
                <input
                  type="password"
                  value={authForm.password}
                  onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
                  placeholder="••••••••"
                />
              </label>

              <button className="primaryButton fullWidth" type="button" onClick={handleAuthSubmit} disabled={authSubmitDisabled}>
                {authPending ? <LoaderCircle size={18} className="spin" /> : authMode === 'register' ? <UserPlus size={18} /> : <ShieldCheck size={18} />}
                {authMode === 'register' ? 'Создать профиль' : 'Войти'}
              </button>
            </section>
          ) : null}

          {snapshot.accounts.length > 0 ? (
            <section className="accountList" aria-label="Сохраненные профили">
              <small>Профили</small>
              {snapshot.accounts.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  className={snapshot.session?.accountId === account.id ? 'accountItem active' : 'accountItem'}
                  onClick={() => {
                    setAuthMode('login');
                    setAuthForm({ login: account.login, username: account.username, password: '' });
                    setUiMessage('Введите пароль для выбранного профиля.');
                  }}
                >
                  <span>{account.username}</span>
                  <small>{account.login}</small>
                </button>
              ))}
            </section>
          ) : null}
        </aside>

        <section className="playPane" aria-label="Запуск FlexCraft">
          <div className="serverStrip">
            <Server size={19} />
            <div>
              <small>Сервер</small>
              <strong>{serverValue}</strong>
            </div>
          </div>

          <div className="launchCard">
            <span className={snapshot.status.installed ? 'readyDot ready' : 'readyDot'} />
            <p>{mainStatus}</p>
            <h1>{statusText}</h1>

            <div className="launcherProgress" aria-label="Готовность клиента">
              <span style={{ width: progressWidth }} />
            </div>

            {snapshot.status.progress ? (
              <div className="progressMeta">
                <span>{snapshot.status.progress.detail}</span>
                <strong>{formatPercent(snapshot.status.progress.percent)}</strong>
              </div>
            ) : (
              <div className="progressMeta">
                <span>{shortVersion(snapshot.status.latestRelease)}</span>
                <strong>{snapshot.status.installed ? 'Готово' : 'Ожидает'}</strong>
              </div>
            )}
          </div>

          <div className="launchActions">
            <button className="primaryButton playNow" type="button" onClick={handleLaunch} disabled={launchDisabled || savePending}>
              {busy || snapshot.status.isLaunching ? <LoaderCircle size={21} className="spin" /> : <Play size={21} fill="currentColor" />}
              Играть
            </button>
            <button className="secondaryButton" type="button" onClick={handleInstall} disabled={installDisabled || savePending}>
              {busy ? <LoaderCircle size={18} className="spin" /> : <RefreshCw size={18} />}
              Обновить
            </button>
          </div>

          {!snapshot.session ? <p className="quietNotice">Создайте профиль или войдите, чтобы запустить игру.</p> : null}
          {snapshot.status.warning ? <p className="quietNotice">{snapshot.status.warning}</p> : null}
          {snapshot.status.lastError ? <p className="quietNotice error">{snapshot.status.lastError}</p> : null}
          {uiMessage ? <p className="quietNotice info">{uiMessage}</p> : null}
        </section>

        <aside className="settingsPane" aria-label="Настройки запуска">
          <button className="settingsToggle" type="button" onClick={() => setSettingsOpen((open) => !open)}>
            <span>
              <Settings size={17} />
              Настройки
            </span>
            <ChevronDown size={17} className={settingsOpen ? 'rotated' : ''} />
          </button>

          <div className="statusChecks">
            <span><Check size={16} /> {snapshot.status.installed ? 'Клиент готов' : 'Файлы не скачаны'}</span>
            <span><Cpu size={16} /> {sourceLabel(snapshot.status.javaSource)}</span>
            <span><Server size={16} /> {serverValue}</span>
          </div>

          <div className={settingsOpen ? 'settingsFields open' : 'settingsFields'}>
            <label className="field">
              <span><Server size={16} /> Адрес сервера</span>
              <input
                value={form.serverAddress}
                onChange={(event) => setForm((current) => ({ ...current, serverAddress: event.target.value }))}
                onBlur={() => void saveConfig({ serverAddress: form.serverAddress })}
                placeholder="flex-craft.ru:25565"
              />
            </label>

            <label className="toggleField">
              <span><Cpu size={16} /> Встроенная Java</span>
              <input
                type="checkbox"
                checked={form.useBundledJava}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setForm((current) => ({ ...current, useBundledJava: checked }));
                  void saveConfig({ useBundledJava: checked });
                }}
              />
            </label>

            <label className="field">
              <span>Своя Java</span>
              <input
                value={form.javaExecutable}
                onChange={(event) => setForm((current) => ({ ...current, javaExecutable: event.target.value }))}
                onBlur={() => void saveConfig({ javaExecutable: form.javaExecutable })}
                placeholder={form.useBundledJava ? 'Необязательно' : 'C:\\Program Files\\Java\\bin\\java.exe'}
              />
            </label>

            <div className="memoryGrid">
              <label className="field">
                <span>Мин. память</span>
                <input
                  type="number"
                  value={form.minMemoryMb}
                  min={1024}
                  step={256}
                  onChange={(event) => setForm((current) => ({ ...current, minMemoryMb: Number(event.target.value) || 1024 }))}
                  onBlur={() => void saveConfig({ minMemoryMb: form.minMemoryMb })}
                />
              </label>

              <label className="field">
                <span>Макс. память</span>
                <input
                  type="number"
                  value={form.maxMemoryMb}
                  min={form.minMemoryMb}
                  step={256}
                  onChange={(event) => setForm((current) => ({ ...current, maxMemoryMb: Number(event.target.value) || current.minMemoryMb }))}
                  onBlur={() => void saveConfig({ maxMemoryMb: form.maxMemoryMb })}
                />
              </label>
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}
