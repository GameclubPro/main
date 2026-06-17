import { Check, KeyRound, LoaderCircle, LockKeyhole, MessageCircle, Send, ShieldCheck, Unlink, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { apiError, apiGet, apiPost, type AuthProvider, type FlexUser } from '../authClient';

const providerLabels: Record<string, string> = {
  vk: 'VK ID',
  telegram: 'Telegram',
  max: 'MAX',
};

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

function providerLabel(provider: string): string {
  return providerLabels[provider] ?? provider;
}

function displayName(user: FlexUser): string {
  return user.displayName || user.nickname || user.login;
}

function providerIcon(provider: string) {
  return providerIcons[provider] ?? ShieldCheck;
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
            <small>{linkedProviders.size > 0 ? `Вход: ${[...linkedProviders].map(providerLabel).join(', ')}` : user.login}</small>
          </div>
        </div>

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
  const [userCode, setUserCode] = useState(new URLSearchParams(window.location.search).get('code') ?? '');
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

  const approve = async () => {
    setPending(true);
    setError('');
    setMessage('');
    try {
      await apiPost('/launcher/device/approve', { userCode });
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
              <small>Введите код из лаунчера</small>
            </div>
          </div>
          <label className="field">
            <span><KeyRound size={16} /> Код</span>
            <input value={userCode} maxLength={9} onChange={(event) => setUserCode(event.target.value.toUpperCase())} placeholder="A1B2C3D4" />
          </label>
          <button className="primaryCta authButton" type="button" disabled={pending || userCode.replace(/\s+/g, '').length < 8} onClick={approve}>
            {pending ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}
            Подключить
          </button>
          {message ? <p className="authNote success">{message}</p> : null}
          {error ? <p className="authNote error">{error}</p> : null}
        </section>
      ) : null}
    </AuthShell>
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
