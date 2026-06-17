import { Check, LoaderCircle, LockKeyhole, MessageCircle, PenLine, Send, ShieldCheck, Unlink, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { apiError, apiGet, apiPost, type AuthProvider, type FlexUser } from '../authClient';

const providerIcons: Record<string, React.ElementType> = {
  vk: MessageCircle,
  telegram: Send,
  max: ShieldCheck,
};

interface SiteAuthPanelProps {
  compact?: boolean;
  userOverride?: FlexUser | null;
  providersOverride?: AuthProvider[];
  onUserChange?: (user: FlexUser | null) => void;
  onProvidersChange?: (providers: AuthProvider[]) => void;
}

function currentReturnPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}` || '/#account';
}

function providerLoginUrl(provider: string): string {
  const params = new URLSearchParams({ returnTo: currentReturnPath() });
  return `/api/auth/${provider}/start?${params.toString()}`;
}

function displayName(user: FlexUser): string {
  return user.displayName || user.nickname || user.login;
}

function providerIcon(provider: string) {
  return providerIcons[provider] ?? ShieldCheck;
}

function hasConfirmedNickname(user: FlexUser | null): boolean {
  return Boolean(user?.nicknameSet || user?.player?.nicknameSet);
}

function normalizeNicknameInput(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
}

function getLauncherDeviceCode(): string {
  const params = new URLSearchParams(window.location.search);
  return String(params.get('device') || '').trim();
}

function ProviderButton({ provider, pending }: { provider: AuthProvider; pending: boolean }) {
  const Icon = providerIcon(provider.id);

  if (!provider.enabled) {
    return (
      <button className="providerButton disabled" type="button" disabled>
        <Icon size={18} />
        <span>{provider.label}</span>
        <small>скоро</small>
      </button>
    );
  }

  return (
    <a className="providerButton primary" href={providerLoginUrl(provider.id)} aria-disabled={pending}>
      {pending ? <LoaderCircle size={18} className="spin" /> : <Icon size={18} />}
      <span>Войти через {provider.label}</span>
    </a>
  );
}

function NicknameForm({
  user,
  onUserChange,
}: {
  user: FlexUser;
  onUserChange: (user: FlexUser) => void;
}) {
  const confirmed = hasConfirmedNickname(user);
  const [nickname, setNickname] = useState(user.nickname || '');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setNickname(user.nickname || '');
  }, [user.nickname]);

  const submit = async () => {
    setPending(true);
    setMessage('');
    setError('');
    try {
      const result = await apiPost('/player/nickname', { nickname });
      if (result.user) {
        onUserChange(result.user);
      }
      setMessage('Игровой ник сохранён.');
    } catch (requestError) {
      setError(apiError(requestError));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={confirmed ? 'nicknameBox' : 'nicknameBox required'}>
      <div className="nicknameHeader">
        <span><PenLine size={16} /> Игровой ник</span>
        <small>{confirmed ? 'готово' : 'обязательно'}</small>
      </div>
      <label className="field nicknameField">
        <input
          value={nickname}
          minLength={3}
          maxLength={16}
          onChange={(event) => setNickname(normalizeNicknameInput(event.target.value))}
          placeholder="Player_123"
          autoComplete="nickname"
        />
      </label>
      <p className="nicknameRules">
        3-16 символов: латинские буквы, цифры и _. Без рекламы, мата, 18+, бессмысленных цифр и ников под администрацию.
      </p>
      <button
        className="primaryCta authButton"
        type="button"
        onClick={submit}
        disabled={pending || confirmed || nickname.length < 3}
      >
        {pending ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}
        Сохранить ник
      </button>
      {message ? <p className="authNote success">{message}</p> : null}
      {error ? <p className="authNote error">{error}</p> : null}
    </div>
  );
}

export function SiteAuthPanel({
  compact = false,
  userOverride,
  providersOverride,
  onUserChange,
  onProvidersChange,
}: SiteAuthPanelProps) {
  const controlledUser = userOverride !== undefined;
  const controlledProviders = providersOverride !== undefined;
  const [localUser, setLocalUser] = useState<FlexUser | null>(null);
  const [localProviders, setLocalProviders] = useState<AuthProvider[]>([]);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const user = controlledUser ? userOverride ?? null : localUser;
  const providers = controlledProviders ? providersOverride ?? [] : localProviders;

  const updateUser = (nextUser: FlexUser | null) => {
    if (!controlledUser) {
      setLocalUser(nextUser);
    }
    onUserChange?.(nextUser);
  };

  const updateProviders = (nextProviders: AuthProvider[]) => {
    if (!controlledProviders) {
      setLocalProviders(nextProviders);
    }
    onProvidersChange?.(nextProviders);
  };

  useEffect(() => {
    let mounted = true;
    const params = new URLSearchParams(window.location.search);
    const authError = params.get('auth_error');
    if (authError) {
      setError(authError);
      params.delete('auth_error');
      const clean = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}${window.location.hash}`;
      window.history.replaceState(null, '', clean);
    }

    void apiGet('/auth/me')
      .then((result) => {
        if (mounted) {
          updateUser(result.user ?? null);
          updateProviders(result.providers ?? []);
        }
      })
      .catch((requestError) => {
        if (mounted) {
          setError(apiError(requestError));
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  const visibleProviders = useMemo(() => {
    if (providers.length > 0) {
      return providers;
    }
    return [
      { id: 'vk', label: 'VK ID', enabled: true },
      { id: 'telegram', label: 'Telegram', enabled: false },
      { id: 'max', label: 'MAX', enabled: false },
    ];
  }, [providers]);

  const logout = async () => {
    setPending(true);
    setError('');
    try {
      await apiPost('/auth/logout');
      updateUser(null);
      setMessage('Вы вышли из аккаунта.');
    } catch (requestError) {
      setError(apiError(requestError));
    } finally {
      setPending(false);
    }
  };

  if (user) {
    const linkedProviders = new Set(user.linkedProviders ?? user.identities?.map((identity) => identity.provider) ?? []);
    return (
      <section className={compact ? 'siteAuthPanel compact' : 'siteAuthPanel'}>
        <div className="authIdentity">
          {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span><UserRound size={20} /></span>}
          <div>
            <strong>{displayName(user)}</strong>
            <small>{hasConfirmedNickname(user) ? user.nickname : 'Выберите игровой ник'}</small>
          </div>
        </div>

        {!hasConfirmedNickname(user) ? <NicknameGate user={user} onUserChange={updateUser} /> : null}

        <div className="linkedProviders" aria-label="Подключенные платформы">
          {visibleProviders.map((provider) => {
            const Icon = providerIcon(provider.id);
            const linked = linkedProviders.has(provider.id);
            if (!linked && provider.enabled) {
              return (
                <a className="providerStatus action" href={providerLoginUrl(provider.id)} key={provider.id} aria-disabled={pending}>
                  {pending ? <LoaderCircle size={17} className="spin" /> : <Icon size={17} />}
                  <span>{provider.label}</span>
                  <small>подключить</small>
                </a>
              );
            }
            return (
              <div className={linked ? 'providerStatus linked' : 'providerStatus'} key={provider.id}>
                <Icon size={17} />
                <span>{provider.label}</span>
                <small>{linked ? 'подключено' : 'скоро'}</small>
              </div>
            );
          })}
        </div>

        <button className="secondaryCta authButton" type="button" onClick={logout} disabled={pending}>
          {pending ? <LoaderCircle size={18} className="spin" /> : <Unlink size={18} />}
          Выйти
        </button>
        {message ? <p className="authNote success">{message}</p> : null}
        {error ? <p className="authNote error">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className={compact ? 'siteAuthPanel compact' : 'siteAuthPanel'}>
      <div className="authProviderStack">
        {visibleProviders.map((provider) => (
          <ProviderButton key={provider.id} provider={provider} pending={pending} />
        ))}
      </div>
      {message ? <p className="authNote success">{message}</p> : null}
      {error ? <p className="authNote error">{error}</p> : null}
    </section>
  );
}

export function LauncherLinkPage() {
  const [user, setUser] = useState<FlexUser | null>(null);
  const [deviceCode] = useState(getLauncherDeviceCode);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get('auth_error');
    if (authError) {
      setError(authError);
      params.delete('auth_error');
      const clean = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}${window.location.hash}`;
      window.history.replaceState(null, '', clean);
    }

    void apiGet('/auth/me').then((result) => setUser(result.user ?? null)).catch(() => setUser(null));
  }, []);

  useEffect(() => {
    if (!user || !hasConfirmedNickname(user) || !deviceCode || pending || message || error) {
      return;
    }

    setPending(true);
    setError('');
    setMessage('');
    void apiPost('/launcher/device/approve', { deviceCode })
      .then(() => {
        setMessage('Лаунчер подключён. Можно возвращаться в приложение.');
      })
      .catch((requestError) => {
        setError(apiError(requestError));
      })
      .finally(() => {
        setPending(false);
      });
  }, [deviceCode, error, message, pending, user]);

  const approve = async () => {
    setPending(true);
    setError('');
    setMessage('');
    try {
      await apiPost('/launcher/device/approve', { deviceCode });
      setMessage('Лаунчер подключён. Можно вернуться в приложение.');
    } catch (requestError) {
      setError(apiError(requestError));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthShell title="Подключение лаунчера">
      {!user ? <SiteAuthPanel /> : null}
      {user ? (
        <section className="siteAuthPanel standalone">
          <div className="authIdentity">
            {user.avatarUrl ? <img src={user.avatarUrl} alt="" /> : <span><ShieldCheck size={20} /></span>}
            <div>
              <strong>{displayName(user)}</strong>
              <small>{hasConfirmedNickname(user) ? 'Лаунчер подключится автоматически' : 'Сначала сохраните игровой ник'}</small>
            </div>
          </div>
          {!hasConfirmedNickname(user) ? <NicknameGate user={user} onUserChange={setUser} /> : null}
          {hasConfirmedNickname(user) && deviceCode ? (
            <div className="linkStatusBox site">
              <span>{pending ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />} {message ? 'Готово' : 'Подключаем лаунчер'}</span>
              <small>{message || 'Оставьте эту вкладку открытой на несколько секунд.'}</small>
            </div>
          ) : null}
          {hasConfirmedNickname(user) && !deviceCode ? <p className="authNote error">Откройте эту страницу из лаунчера.</p> : null}
          {hasConfirmedNickname(user) && deviceCode && error ? (
            <button className="primaryCta authButton" type="button" disabled={pending} onClick={approve}>
              {pending ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}
              Повторить
            </button>
          ) : null}
          {message ? <p className="authNote success">{message}</p> : null}
          {error ? <p className="authNote error">{error}</p> : null}
        </section>
      ) : null}
    </AuthShell>
  );
}

function NicknameGate({ user, onUserChange }: { user: FlexUser; onUserChange: (user: FlexUser) => void }) {
  return (
    <div className="nicknameOverlay" role="dialog" aria-modal="true" aria-labelledby="nickname-title">
      <section className="nicknameModal">
        <div className="nicknameModalHeader">
          <span><PenLine size={18} /></span>
          <div>
            <h2 id="nickname-title">Придумайте игровой ник</h2>
            <p>Этот ник будет использоваться на сервере и в лаунчере. После сохранения изменить его нельзя.</p>
          </div>
        </div>
        <NicknameForm user={user} onUserChange={onUserChange} />
      </section>
    </div>
  );
}

function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="authPageShell">
      <a className="brandMark" href="/">
        <span className="brandIcon"><ShieldCheck size={20} /></span>
        <span>FlexCraft</span>
      </a>
      <div className="authPageGrid">
        <section className="authPageIntro">
          <p className="siteEyebrow"><LockKeyhole size={15} /> Аккаунт</p>
          <h1>{title}</h1>
          <p>Единый профиль FlexCraft для сайта и лаунчера. Сейчас доступен VK ID, дальше сюда добавятся Telegram и MAX.</p>
        </section>
        {children}
      </div>
    </main>
  );
}
