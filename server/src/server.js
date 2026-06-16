import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import nodemailer from 'nodemailer';

const scrypt = promisify(scryptCallback);
const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3088);
const host = process.env.HOST || '127.0.0.1';
const publicOrigin = (process.env.PUBLIC_ORIGIN || 'https://flex-craft.ru').replace(/\/+$/, '');
const dataDir = process.env.AUTH_DATA_DIR || path.join(process.cwd(), 'data');
const dataPath = path.join(dataDir, 'auth-store.json');
const cookieName = process.env.AUTH_SESSION_COOKIE || 'flexcraft_session';
const cookieSecret = process.env.AUTH_COOKIE_SECRET || '';
const maxJsonBytes = 64 * 1024;
const sessionMaxAgeSeconds = 60 * 60 * 24 * 30;
const verifyTokenTtlMs = 1000 * 60 * 60 * 24;
const passwordResetTtlMs = 1000 * 60 * 60;
const launcherDeviceTtlMs = 1000 * 60 * 10;
const launcherPollIntervalSeconds = 3;

if (isProduction && cookieSecret.length < 32) {
  throw new Error('AUTH_COOKIE_SECRET must be at least 32 characters in production.');
}

const app = Fastify({
  logger: true,
  trustProxy: true,
  bodyLimit: maxJsonBytes,
});

await app.register(cookie, {
  secret: cookieSecret || undefined,
  hook: 'onRequest',
});

function nowIso() {
  return new Date().toISOString();
}

function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeLogin(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 32);
}

function normalizeNickname(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value) && value.length <= 254;
}

function isValidLogin(value) {
  return /^[a-z0-9_.-]{3,32}$/.test(value);
}

function isValidNickname(value) {
  return /^[A-Za-z0-9_]{3,16}$/.test(value);
}

function validatePassword(value) {
  const password = String(value || '');
  if (password.length < 10) {
    return 'Пароль должен быть не короче 10 символов.';
  }
  if (password.length > 256) {
    return 'Пароль слишком длинный.';
  }
  return '';
}

function publicUser(user) {
  return {
    id: user.id,
    login: user.login,
    nickname: user.nickname,
    email: user.email,
    emailVerified: Boolean(user.emailVerified),
    createdAt: user.createdAt,
  };
}

function createEmptyStore() {
  return {
    version: 1,
    users: [],
    sessions: [],
    emailTokens: [],
    launcherDevices: [],
    audit: [],
  };
}

async function loadStore() {
  try {
    const raw = (await readFile(dataPath, 'utf8')).replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    return {
      ...createEmptyStore(),
      ...parsed,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      emailTokens: Array.isArray(parsed.emailTokens) ? parsed.emailTokens : [],
      launcherDevices: Array.isArray(parsed.launcherDevices) ? parsed.launcherDevices : [],
      audit: Array.isArray(parsed.audit) ? parsed.audit : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return createEmptyStore();
    }
    throw error;
  }
}

let writeQueue = Promise.resolve();

async function saveStore(store) {
  await mkdir(dataDir, { recursive: true });
  const tempPath = `${dataPath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(store, null, 2)}\n`;
  writeQueue = writeQueue.then(async () => {
    await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, dataPath);
  });
  return writeQueue;
}

async function mutateStore(mutator) {
  const store = await loadStore();
  cleanupStore(store);
  const result = await mutator(store);
  await saveStore(store);
  return result;
}

function cleanupStore(store) {
  const now = Date.now();
  store.sessions = store.sessions.filter((session) => Date.parse(session.expiresAt) > now);
  store.emailTokens = store.emailTokens.filter((token) => Date.parse(token.expiresAt) > now);
  store.launcherDevices = store.launcherDevices.filter((device) => Date.parse(device.expiresAt) > now);
  store.audit = store.audit.slice(-500);
}

async function hashPassword(password) {
  const salt = randomBytes(16).toString('base64url');
  const key = await scrypt(password, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt}$${Buffer.from(key).toString('base64url')}`;
}

async function verifyPassword(password, encoded) {
  const [kind, nValue, rValue, pValue, salt, expected] = String(encoded || '').split('$');
  if (kind !== 'scrypt' || !salt || !expected) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, 'base64url');
  const key = await scrypt(password, salt, expectedBuffer.length, {
    N: Number(nValue),
    r: Number(rValue),
    p: Number(pValue),
    maxmem: 64 * 1024 * 1024,
  });
  const actualBuffer = Buffer.from(key);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function createMailer() {
  const hostName = process.env.SMTP_HOST;
  if (!hostName) {
    return null;
  }

  return nodemailer.createTransport({
    host: hostName,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS || '',
        }
      : undefined,
  });
}

const mailer = createMailer();

async function sendEmail({ to, subject, text }) {
  if (!mailer) {
    app.log.warn({ to, subject, text }, 'SMTP is not configured; email content was logged instead.');
    return;
  }

  await mailer.sendMail({
    from: process.env.SMTP_FROM || 'FlexCraft <no-reply@flex-craft.ru>',
    to,
    subject,
    text,
  });
}

async function sendVerificationEmail(user, rawToken) {
  const link = `${publicOrigin}/auth/verify-email?token=${encodeURIComponent(rawToken)}`;
  await sendEmail({
    to: user.email,
    subject: 'Подтвердите email FlexCraft',
    text: `Привет, ${user.nickname}!\n\nПодтвердите email для FlexCraft:\n${link}\n\nСсылка действует 24 часа.`,
  });
}

async function sendPasswordResetEmail(user, rawToken) {
  const link = `${publicOrigin}/auth/reset-password?token=${encodeURIComponent(rawToken)}`;
  await sendEmail({
    to: user.email,
    subject: 'Восстановление пароля FlexCraft',
    text: `Привет, ${user.nickname}!\n\nСсылка для смены пароля:\n${link}\n\nОна действует 1 час. Если вы не запрашивали смену пароля, просто игнорируйте письмо.`,
  });
}

function setSessionCookie(reply, sessionToken) {
  reply.setCookie(cookieName, sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: sessionMaxAgeSeconds,
  });
}

function clearSessionCookie(reply) {
  reply.clearCookie(cookieName, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
  });
}

function getSessionToken(request) {
  const signedValue = request.unsignCookie?.(request.cookies?.[cookieName] || '');
  if (signedValue?.valid && signedValue.value) {
    return signedValue.value;
  }
  return request.cookies?.[cookieName] || '';
}

async function getSessionUser(request) {
  const token = getSessionToken(request);
  if (!token) {
    return null;
  }

  const store = await loadStore();
  cleanupStore(store);
  const tokenHash = sha256(token);
  const session = store.sessions.find((entry) => entry.tokenHash === tokenHash);
  if (!session) {
    return null;
  }

  const user = store.users.find((entry) => entry.id === session.userId);
  return user ? { user, session } : null;
}

async function createSession(store, user, meta = {}) {
  const token = randomToken(32);
  const session = {
    id: randomToken(12),
    userId: user.id,
    tokenHash: sha256(token),
    createdAt: nowIso(),
    expiresAt: isoIn(sessionMaxAgeSeconds * 1000),
    ...meta,
  };
  store.sessions.push(session);
  return token;
}

function getClientIp(request) {
  return request.headers['x-forwarded-for']?.split(',')[0]?.trim() || request.ip || '';
}

function addAudit(store, event, request, details = {}) {
  store.audit.push({
    id: randomToken(8),
    event,
    ip: getClientIp(request),
    userAgent: request.headers['user-agent'] || '',
    details,
    createdAt: nowIso(),
  });
}

function badRequest(reply, message) {
  return reply.code(400).send({ ok: false, error: message });
}

app.addHook('onRequest', async (request, reply) => {
  if (request.method === 'OPTIONS') {
    reply
      .header('Access-Control-Allow-Origin', publicOrigin)
      .header('Access-Control-Allow-Credentials', 'true')
      .header('Access-Control-Allow-Headers', 'content-type')
      .header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      .code(204)
      .send();
  }
});

app.addHook('onSend', async (_request, reply) => {
  reply.header('Cache-Control', 'no-store');
});

app.get('/api/health', async () => ({ ok: true, hostname: os.hostname(), time: nowIso() }));

app.get('/api/auth/me', async (request) => {
  const session = await getSessionUser(request);
  return { ok: true, user: session ? publicUser(session.user) : null };
});

app.post('/api/auth/register', async (request, reply) => {
  const login = normalizeLogin(request.body?.login);
  const nickname = normalizeNickname(request.body?.nickname);
  const email = normalizeEmail(request.body?.email);
  const password = String(request.body?.password || '');
  const passwordError = validatePassword(password);

  if (!isValidLogin(login)) {
    return badRequest(reply, 'Логин должен быть 3-32 символа: латиница, цифры, точка, дефис или подчёркивание.');
  }
  if (!isValidNickname(nickname)) {
    return badRequest(reply, 'Ник должен быть 3-16 символов: латиница, цифры или подчёркивание.');
  }
  if (!isValidEmail(email)) {
    return badRequest(reply, 'Введите корректный email.');
  }
  if (passwordError) {
    return badRequest(reply, passwordError);
  }

  return mutateStore(async (store) => {
    if (store.users.some((user) => user.login === login)) {
      return reply.code(409).send({ ok: false, error: 'Такой логин уже занят.' });
    }
    if (store.users.some((user) => user.email === email)) {
      return reply.code(409).send({ ok: false, error: 'Этот email уже используется.' });
    }
    if (store.users.some((user) => user.nickname.toLowerCase() === nickname.toLowerCase())) {
      return reply.code(409).send({ ok: false, error: 'Такой ник уже занят.' });
    }

    const user = {
      id: randomToken(16),
      login,
      nickname,
      email,
      emailVerified: false,
      passwordHash: await hashPassword(password),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    const rawToken = randomToken(32);
    store.users.push(user);
    store.emailTokens.push({
      id: randomToken(8),
      userId: user.id,
      type: 'verify-email',
      tokenHash: sha256(rawToken),
      createdAt: nowIso(),
      expiresAt: isoIn(verifyTokenTtlMs),
    });
    addAudit(store, 'auth.register', request, { userId: user.id });
    await sendVerificationEmail(user, rawToken);
    return reply.code(201).send({ ok: true, user: publicUser(user), emailSent: Boolean(mailer) });
  });
});

app.post('/api/auth/login', async (request, reply) => {
  const identity = String(request.body?.loginOrEmail || request.body?.login || '').trim().toLowerCase();
  const password = String(request.body?.password || '');

  if (!identity || !password) {
    return badRequest(reply, 'Введите логин/email и пароль.');
  }

  return mutateStore(async (store) => {
    const user = store.users.find((entry) => entry.login === identity || entry.email === identity);
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      addAudit(store, 'auth.login_failed', request, { identity });
      return reply.code(401).send({ ok: false, error: 'Неверный логин или пароль.' });
    }
    if (!user.emailVerified) {
      return reply.code(403).send({ ok: false, error: 'Сначала подтвердите email.' });
    }

    user.lastLoginAt = nowIso();
    const sessionToken = await createSession(store, user, { kind: 'web' });
    addAudit(store, 'auth.login', request, { userId: user.id });
    setSessionCookie(reply, sessionToken);
    return reply.send({ ok: true, user: publicUser(user) });
  });
});

app.post('/api/auth/logout', async (request, reply) => {
  const token = getSessionToken(request);
  await mutateStore(async (store) => {
    const tokenHash = sha256(token);
    store.sessions = store.sessions.filter((session) => session.tokenHash !== tokenHash);
    addAudit(store, 'auth.logout', request);
  });
  clearSessionCookie(reply);
  return { ok: true };
});

app.post('/api/auth/resend-verification', async (request, reply) => {
  const email = normalizeEmail(request.body?.email);
  if (!isValidEmail(email)) {
    return badRequest(reply, 'Введите корректный email.');
  }

  await mutateStore(async (store) => {
    const user = store.users.find((entry) => entry.email === email);
    if (!user || user.emailVerified) {
      return;
    }

    const rawToken = randomToken(32);
    store.emailTokens.push({
      id: randomToken(8),
      userId: user.id,
      type: 'verify-email',
      tokenHash: sha256(rawToken),
      createdAt: nowIso(),
      expiresAt: isoIn(verifyTokenTtlMs),
    });
    await sendVerificationEmail(user, rawToken);
  });

  return { ok: true };
});

app.get('/api/auth/verify-email', async (request, reply) => {
  const token = String(request.query?.token || '');
  if (!token) {
    return badRequest(reply, 'Нет токена подтверждения.');
  }

  return mutateStore(async (store) => {
    const tokenHash = sha256(token);
    const tokenEntry = store.emailTokens.find((entry) => entry.type === 'verify-email' && entry.tokenHash === tokenHash);
    if (!tokenEntry || Date.parse(tokenEntry.expiresAt) <= Date.now()) {
      return reply.code(400).send({ ok: false, error: 'Ссылка подтверждения устарела или уже использована.' });
    }

    const user = store.users.find((entry) => entry.id === tokenEntry.userId);
    if (!user) {
      return reply.code(400).send({ ok: false, error: 'Пользователь не найден.' });
    }

    user.emailVerified = true;
    user.updatedAt = nowIso();
    store.emailTokens = store.emailTokens.filter((entry) => entry.id !== tokenEntry.id);
    const sessionToken = await createSession(store, user, { kind: 'web' });
    addAudit(store, 'auth.verify_email', request, { userId: user.id });
    setSessionCookie(reply, sessionToken);
    return reply.send({ ok: true, user: publicUser(user) });
  });
});

app.post('/api/auth/request-password-reset', async (request, reply) => {
  const email = normalizeEmail(request.body?.email);
  if (!isValidEmail(email)) {
    return badRequest(reply, 'Введите корректный email.');
  }

  await mutateStore(async (store) => {
    const user = store.users.find((entry) => entry.email === email && entry.emailVerified);
    if (!user) {
      return;
    }
    const rawToken = randomToken(32);
    store.emailTokens.push({
      id: randomToken(8),
      userId: user.id,
      type: 'reset-password',
      tokenHash: sha256(rawToken),
      createdAt: nowIso(),
      expiresAt: isoIn(passwordResetTtlMs),
    });
    await sendPasswordResetEmail(user, rawToken);
  });

  return { ok: true };
});

app.post('/api/auth/reset-password', async (request, reply) => {
  const token = String(request.body?.token || '');
  const password = String(request.body?.password || '');
  const passwordError = validatePassword(password);
  if (!token) {
    return badRequest(reply, 'Нет токена восстановления.');
  }
  if (passwordError) {
    return badRequest(reply, passwordError);
  }

  return mutateStore(async (store) => {
    const tokenHash = sha256(token);
    const tokenEntry = store.emailTokens.find((entry) => entry.type === 'reset-password' && entry.tokenHash === tokenHash);
    if (!tokenEntry || Date.parse(tokenEntry.expiresAt) <= Date.now()) {
      return reply.code(400).send({ ok: false, error: 'Ссылка восстановления устарела или уже использована.' });
    }
    const user = store.users.find((entry) => entry.id === tokenEntry.userId);
    if (!user) {
      return reply.code(400).send({ ok: false, error: 'Пользователь не найден.' });
    }

    user.passwordHash = await hashPassword(password);
    user.updatedAt = nowIso();
    store.emailTokens = store.emailTokens.filter((entry) => entry.id !== tokenEntry.id);
    store.sessions = store.sessions.filter((session) => session.userId !== user.id);
    addAudit(store, 'auth.reset_password', request, { userId: user.id });
    return reply.send({ ok: true });
  });
});

app.post('/api/launcher/device/start', async (request) => {
  const deviceCode = randomToken(32);
  const userCode = randomBytes(4).toString('hex').toUpperCase();
  await mutateStore(async (store) => {
    store.launcherDevices.push({
      id: randomToken(8),
      deviceCodeHash: sha256(deviceCode),
      userCodeHash: sha256(userCode),
      status: 'pending',
      userId: null,
      createdAt: nowIso(),
      expiresAt: isoIn(launcherDeviceTtlMs),
    });
    addAudit(store, 'launcher.device_start', request);
  });

  return {
    ok: true,
    deviceCode,
    userCode,
    verificationUri: `${publicOrigin}/launcher/link`,
    verificationUriComplete: `${publicOrigin}/launcher/link?code=${encodeURIComponent(userCode)}`,
    expiresIn: Math.floor(launcherDeviceTtlMs / 1000),
    interval: launcherPollIntervalSeconds,
  };
});

app.post('/api/launcher/device/approve', async (request, reply) => {
  const session = await getSessionUser(request);
  if (!session?.user) {
    return reply.code(401).send({ ok: false, error: 'Войдите на сайте, чтобы подключить лаунчер.' });
  }

  const userCode = String(request.body?.userCode || '').trim().replace(/\s+/g, '').toUpperCase();
  if (!/^[A-F0-9]{8}$/.test(userCode)) {
    return badRequest(reply, 'Введите 8-значный код из лаунчера.');
  }

  return mutateStore(async (store) => {
    const device = store.launcherDevices.find((entry) => entry.userCodeHash === sha256(userCode));
    if (!device || Date.parse(device.expiresAt) <= Date.now()) {
      return reply.code(404).send({ ok: false, error: 'Код не найден или устарел.' });
    }
    if (device.status !== 'pending') {
      return reply.code(409).send({ ok: false, error: 'Этот код уже использован.' });
    }

    device.status = 'approved';
    device.userId = session.user.id;
    device.approvedAt = nowIso();
    addAudit(store, 'launcher.device_approve', request, { userId: session.user.id });
    return reply.send({ ok: true });
  });
});

app.post('/api/launcher/device/poll', async (request, reply) => {
  const deviceCode = String(request.body?.deviceCode || '');
  if (!deviceCode) {
    return badRequest(reply, 'Нет deviceCode.');
  }

  return mutateStore(async (store) => {
    const device = store.launcherDevices.find((entry) => entry.deviceCodeHash === sha256(deviceCode));
    if (!device || Date.parse(device.expiresAt) <= Date.now()) {
      return reply.code(400).send({ ok: false, status: 'expired', error: 'Код входа устарел.' });
    }
    if (device.status === 'pending') {
      return reply.code(202).send({ ok: true, status: 'pending', interval: launcherPollIntervalSeconds });
    }
    if (device.status !== 'approved' || !device.userId) {
      return reply.code(400).send({ ok: false, status: 'denied', error: 'Вход отклонён.' });
    }

    const user = store.users.find((entry) => entry.id === device.userId);
    if (!user) {
      return reply.code(400).send({ ok: false, status: 'denied', error: 'Пользователь не найден.' });
    }

    const launcherToken = await createSession(store, user, { kind: 'launcher' });
    device.status = 'used';
    device.usedAt = nowIso();
    addAudit(store, 'launcher.device_complete', request, { userId: user.id });
    return reply.send({ ok: true, status: 'approved', token: launcherToken, user: publicUser(user) });
  });
});

app.post('/api/launcher/session/me', async (request, reply) => {
  const bearer = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!bearer) {
    return reply.code(401).send({ ok: false, error: 'Нет токена лаунчера.' });
  }

  const store = await loadStore();
  cleanupStore(store);
  const session = store.sessions.find((entry) => entry.kind === 'launcher' && entry.tokenHash === sha256(bearer));
  const user = session ? store.users.find((entry) => entry.id === session.userId) : null;
  if (!user) {
    return reply.code(401).send({ ok: false, error: 'Сессия лаунчера истекла.' });
  }

  return { ok: true, user: publicUser(user) };
});

app.post('/api/launcher/session/logout', async (request) => {
  const bearer = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!bearer) {
    return { ok: true };
  }

  await mutateStore(async (store) => {
    store.sessions = store.sessions.filter((session) => session.tokenHash !== sha256(bearer));
    addAudit(store, 'launcher.logout', request);
  });
  return { ok: true };
});

app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ ok: false, error: 'Not found' }));

const server = await app.listen({ host, port });
app.log.info(`FlexCraft auth API listening on ${server}`);

async function shutdown(signal) {
  app.log.info({ signal }, 'Shutting down.');
  await app.close();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

http.globalAgent.keepAlive = true;
