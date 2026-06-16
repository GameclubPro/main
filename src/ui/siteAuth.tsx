import { Check, KeyRound, LoaderCircle, LogIn, Mail, RotateCcw, ShieldCheck, UserPlus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { apiError, apiGet, apiPost, type FlexUser } from '../authClient';

type AuthMode = 'login' | 'register' | 'forgot';

interface SiteAuthPanelProps {
  compact?: boolean;
}

function getQueryToken(): string {
  return new URLSearchParams(window.location.search).get('token') ?? '';
}

export function SiteAuthPanel({ compact = false }: SiteAuthPanelProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [user, setUser] = useState<FlexUser | null>(null);
  const [form, setForm] = useState({ login: '', nickname: '', email: '', password: '' });
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let mounted = true;
    void apiGet('/auth/me')
      .then((result) => {
        if (mounted) {
          setUser(result.user ?? null);
        }
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  const canSubmit = useMemo(() => {
    if (pending) {
      return false;
    }
    if (mode === 'forgot') {
      return Boolean(form.email.trim());
    }
    if (mode === 'register') {
      return Boolean(form.login.trim() && form.nickname.trim() && form.email.trim() && form.password.trim());
    }
    return Boolean(form.login.trim() && form.password.trim());
  }, [form, mode, pending]);

  const submit = async () => {
    setPending(true);
    setError('');
    setMessage('');
    try {
      if (mode === 'register') {
        const result = await apiPost('/auth/register', {
          login: form.login,
          nickname: form.nickname,
          email: form.email,
          password: form.password,
        });
        setUser(result.user ?? null);
        setMessage(result.emailSent ? 'Письмо отправлено. Откройте ссылку из почты.' : 'Аккаунт создан. Ссылка подтверждения записана в лог сервера.');
        setMode('login');
      } else if (mode === 'forgot') {
        await apiPost('/auth/request-password-reset', { email: form.email });
        setMessage('Если email есть в базе, мы отправили ссылку для смены пароля.');
      } else {
        const result = await apiPost('/auth/login', {
          loginOrEmail: form.login,
          password: form.password,
        });
        setUser(result.user ?? null);
        setMessage('Вы вошли в аккаунт FlexCraft.');
      }
    } catch (requestError) {
      setError(apiError(requestError));
    } finally {
      setPending(false);
    }
  };

  const logout = async () => {
    setPending(true);
    setError('');
    try {
      await apiPost('/auth/logout');
      setUser(null);
      setMessage('Вы вышли из аккаунта.');
    } catch (requestError) {
      setError(apiError(requestError));
    } finally {
      setPending(false);
    }
  };

  if (user) {
    return (
      <section className={compact ? 'siteAuthPanel compact' : 'siteAuthPanel'}>
        <div className="authIdentity">
          <span><ShieldCheck size={20} /></span>
          <div>
            <strong>{user.nickname}</strong>
            <small>{user.emailVerified ? user.email : 'Email ожидает подтверждения'}</small>
          </div>
        </div>
        <button className="secondaryCta authButton" type="button" onClick={logout} disabled={pending}>
          Выйти
        </button>
        {message ? <p className="authNote success">{message}</p> : null}
        {error ? <p className="authNote error">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className={compact ? 'siteAuthPanel compact' : 'siteAuthPanel'}>
      <div className="authTabs" role="tablist" aria-label="Вход FlexCraft">
        <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
          Войти
        </button>
        <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
          Регистрация
        </button>
      </div>

      {mode === 'register' ? (
        <label className="field">
          <span><ShieldCheck size={16} /> Логин</span>
          <input value={form.login} autoComplete="username" onChange={(event) => setForm((current) => ({ ...current, login: event.target.value }))} />
        </label>
      ) : null}

      {mode === 'register' ? (
        <label className="field">
          <span><UserPlus size={16} /> Никнейм</span>
          <input value={form.nickname} maxLength={16} autoComplete="nickname" onChange={(event) => setForm((current) => ({ ...current, nickname: event.target.value }))} />
        </label>
      ) : null}

      {mode !== 'login' ? (
        <label className="field">
          <span><Mail size={16} /> Email</span>
          <input type="email" value={form.email} autoComplete="email" onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} />
        </label>
      ) : (
        <label className="field">
          <span><ShieldCheck size={16} /> Логин или email</span>
          <input value={form.login} autoComplete="username" onChange={(event) => setForm((current) => ({ ...current, login: event.target.value }))} />
        </label>
      )}

      {mode !== 'forgot' ? (
        <label className="field">
          <span><KeyRound size={16} /> Пароль</span>
          <input type="password" value={form.password} autoComplete={mode === 'register' ? 'new-password' : 'current-password'} onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))} />
        </label>
      ) : null}

      <button className="primaryCta authButton" type="button" onClick={submit} disabled={!canSubmit}>
        {pending ? <LoaderCircle size={18} className="spin" /> : mode === 'register' ? <UserPlus size={18} /> : mode === 'forgot' ? <RotateCcw size={18} /> : <LogIn size={18} />}
        {mode === 'register' ? 'Создать аккаунт' : mode === 'forgot' ? 'Отправить ссылку' : 'Войти'}
      </button>

      <button className="authTextButton" type="button" onClick={() => setMode(mode === 'forgot' ? 'login' : 'forgot')}>
        {mode === 'forgot' ? 'Вернуться ко входу' : 'Забыли пароль?'}
      </button>

      {message ? <p className="authNote success">{message}</p> : null}
      {error ? <p className="authNote error">{error}</p> : null}
    </section>
  );
}

export function VerifyEmailPage() {
  const [state, setState] = useState<'pending' | 'success' | 'error'>('pending');
  const [message, setMessage] = useState('Подтверждаем email...');

  useEffect(() => {
    const token = getQueryToken();
    void apiGet(`/auth/verify-email?token=${encodeURIComponent(token)}`)
      .then(() => {
        setState('success');
        setMessage('Email подтверждён. Теперь можно входить на сайте и в лаунчере.');
      })
      .catch((error) => {
        setState('error');
        setMessage(apiError(error));
      });
  }, []);

  return <AuthResultPage state={state} title="Подтверждение email" message={message} />;
}

export function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    setPending(true);
    setMessage('');
    setError('');
    try {
      await apiPost('/auth/reset-password', { token: getQueryToken(), password });
      setMessage('Пароль обновлён. Теперь можно войти с новым паролем.');
    } catch (requestError) {
      setError(apiError(requestError));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthShell title="Новый пароль">
      <section className="siteAuthPanel standalone">
        <label className="field">
          <span><KeyRound size={16} /> Новый пароль</span>
          <input type="password" value={password} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} />
        </label>
        <button className="primaryCta authButton" type="button" disabled={pending || password.length < 10} onClick={submit}>
          {pending ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}
          Сохранить пароль
        </button>
        {message ? <p className="authNote success">{message}</p> : null}
        {error ? <p className="authNote error">{error}</p> : null}
      </section>
    </AuthShell>
  );
}

export function LauncherLinkPage() {
  const [user, setUser] = useState<FlexUser | null>(null);
  const [userCode, setUserCode] = useState(new URLSearchParams(window.location.search).get('code') ?? '');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
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
            <span><ShieldCheck size={20} /></span>
            <div>
              <strong>{user.nickname}</strong>
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

function AuthResultPage({ state, title, message }: { state: 'pending' | 'success' | 'error'; title: string; message: string }) {
  return (
    <AuthShell title={title}>
      <section className="siteAuthPanel standalone">
        <div className={`authResult ${state}`}>
          {state === 'pending' ? <LoaderCircle size={28} className="spin" /> : <Check size={28} />}
          <p>{message}</p>
        </div>
      </section>
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
          <p className="siteEyebrow"><ShieldCheck size={15} /> Аккаунт</p>
          <h1>{title}</h1>
          <p>Единый профиль FlexCraft для сайта, лаунчера и будущих привязок VK, Telegram и MAX.</p>
        </section>
        {children}
      </div>
    </main>
  );
}
