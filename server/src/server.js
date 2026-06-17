import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const isProduction = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT || 3088);
const host = process.env.HOST || '127.0.0.1';
const publicOrigin = (process.env.PUBLIC_ORIGIN || 'https://flex-craft.ru').replace(/\/+$/, '');
const dataDir = process.env.AUTH_DATA_DIR || path.join(process.cwd(), 'data');
const dataPath = path.join(dataDir, 'auth-store.json');
const cookieName = process.env.AUTH_SESSION_COOKIE || 'flexcraft_session';
const cookieSecret = process.env.AUTH_COOKIE_SECRET || '';
const maxJsonBytes = 256 * 1024;
const sessionMaxAgeSeconds = 60 * 60 * 24 * 30;
const launcherDeviceTtlMs = 1000 * 60 * 10;
const launcherPollIntervalSeconds = 3;
const oauthStateTtlMs = 1000 * 60 * 10;
const vkClientId = String(process.env.VK_CLIENT_ID || process.env.VK_ID_CLIENT_ID || '').trim();
const vkClientSecret = String(process.env.VK_CLIENT_SECRET || process.env.VK_ID_CLIENT_SECRET || '').trim();
const vkRedirectUri = String(process.env.VK_REDIRECT_URI || `${publicOrigin}/api/auth/vk/callback`).trim();
const vkBaseUrl = String(process.env.VK_OAUTH_BASE_URL || 'https://id.vk.ru').replace(/\/+$/, '');
const vkScope = String(process.env.VK_SCOPE || 'vkid.personal_info').trim();
const telegramClientId = String(process.env.TELEGRAM_CLIENT_ID || '').trim();
const telegramClientSecret = String(process.env.TELEGRAM_CLIENT_SECRET || '').trim();
const telegramRedirectUri = String(process.env.TELEGRAM_REDIRECT_URI || `${publicOrigin}/api/auth/telegram/callback`).trim();
const telegramIssuer = String(process.env.TELEGRAM_OIDC_ISSUER || 'https://oauth.telegram.org').replace(/\/+$/, '');
const telegramAuthorizeUrl = String(process.env.TELEGRAM_AUTH_URL || `${telegramIssuer}/auth`).trim();
const telegramTokenUrl = String(process.env.TELEGRAM_TOKEN_URL || `${telegramIssuer}/token`).trim();
const telegramJwksUrl = String(process.env.TELEGRAM_JWKS_URL || `${telegramIssuer}/.well-known/jwks.json`).trim();
const telegramScope = String(process.env.TELEGRAM_SCOPE || 'openid profile').trim();
const gameApiToken = String(process.env.GAME_API_TOKEN || '').trim();

const providerDefinitions = [
  { id: 'vk', label: 'VK ID', enabled: () => Boolean(vkClientId) },
  { id: 'telegram', label: 'Telegram', enabled: () => Boolean(telegramClientId && telegramClientSecret) },
  { id: 'max', label: 'MAX', enabled: () => false },
];

let telegramJwksCache = { keys: [], expiresAt: 0 };

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

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function pkceChallenge(verifier) {
  return base64Url(createHash('sha256').update(verifier, 'utf8').digest());
}

function normalizeNickname(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
}

const reservedNicknameParts = [
  'admin',
  'administrator',
  'moder',
  'moderator',
  'helper',
  'server',
  'tester',
  'operator',
  'support',
  'staff',
  'owner',
  'flexcraft',
  'flex_craft',
  'minecraft',
  'mojang',
  'vk',
  'telegram',
  'max',
];

const forbiddenNicknameParts = [
  'fuck',
  'shit',
  'bitch',
  'dick',
  'sex',
  'porn',
  'nazi',
  'hitler',
  'drug',
  'nark',
  'server',
  'discord',
  'vk_com',
  't_me',
  'http',
  'www',
];

function validatePlayerNickname(value) {
  const nickname = String(value || '').trim();
  const lowerNickname = nickname.toLowerCase();

  if (nickname.length < 3) {
    return { error: 'Ник должен быть от 3 до 16 символов.' };
  }

  if (nickname.length > 16) {
    return { error: 'Ник должен быть не длиннее 16 символов.' };
  }

  if (!/^[A-Za-z0-9_]+$/.test(nickname)) {
    return { error: 'Используйте только латинские буквы, цифры и подчёркивание.' };
  }

  if (/^\d+$/.test(nickname)) {
    return { error: 'Ник не может состоять только из цифр.' };
  }

  if (/__{3,}/.test(nickname)) {
    return { error: 'В нике не должно быть длинной цепочки подчёркиваний.' };
  }

  if (/(.)\1{5,}/i.test(nickname)) {
    return { error: 'Ник выглядит как бессмысленный набор повторяющихся символов.' };
  }

  if (reservedNicknameParts.some((part) => lowerNickname.includes(part))) {
    return { error: 'Ник не должен быть похож на команду проекта или технический аккаунт.' };
  }

  if (forbiddenNicknameParts.some((part) => lowerNickname.includes(part))) {
    return { error: 'Ник не должен содержать рекламу, грубые или запрещённые слова.' };
  }

  return { nickname };
}

function normalizeDisplayName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
}

function getProviderStatus() {
  return providerDefinitions.map((provider) => ({
    id: provider.id,
    label: provider.label,
    enabled: provider.enabled(),
  }));
}

function getSafeReturnPath(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return '/#account';
  }

  try {
    const parsed = new URL(raw, publicOrigin);
    if (parsed.origin !== publicOrigin) {
      return '/#account';
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return raw.startsWith('/') && !raw.startsWith('//') ? raw : '/#account';
  }
}

function getRequestReturnPath(request) {
  return getSafeReturnPath(request.query?.returnTo || request.query?.next || request.headers.referer || '/#account');
}

function getProviderLogin(userId) {
  return `id_${sha256(userId).slice(0, 12)}`;
}

function createNicknameCandidate(profile, providerUserId) {
  const fromName = normalizeNickname(
    [
      profile.first_name,
      profile.last_name,
    ]
      .filter(Boolean)
      .join('_'),
  );

  if (fromName.length >= 3) {
    return fromName;
  }

  return normalizeNickname(`${profile.provider}_${providerUserId}`) || 'FlexCraft';
}

function uniqueNickname(store, preferred, providerUserId) {
  const base = normalizeNickname(preferred) || 'FlexCraft';
  const used = new Set([
    ...store.users.map((user) => String(user.nickname || '').toLowerCase()),
    ...(store.players || []).map((player) => String(player.nickname || '').toLowerCase()),
  ]);

  if (base.length >= 3 && !used.has(base.toLowerCase())) {
    return base;
  }

  const suffix = sha256(providerUserId).slice(0, 6);
  const candidateBase = base.slice(0, Math.max(3, 16 - suffix.length - 1));
  const withSuffix = `${candidateBase}_${suffix}`.slice(0, 16);

  if (!used.has(withSuffix.toLowerCase())) {
    return withSuffix;
  }

  for (let index = 2; index <= 99; index += 1) {
    const nextSuffix = String(index);
    const next = `${candidateBase.slice(0, Math.max(3, 16 - nextSuffix.length))}${nextSuffix}`;
    if (!used.has(next.toLowerCase())) {
      return next;
    }
  }

  return `Player${randomToken(4)}`.slice(0, 16);
}

function profileDisplayName(profile) {
  const displayName = normalizeDisplayName(profile.displayName);
  if (displayName) {
    return displayName;
  }

  const parts = [profile.first_name, profile.last_name].map(normalizeDisplayName).filter(Boolean);
  return parts.join(' ') || `${profile.provider} ${profile.providerUserId}`;
}

function userHasProviderIdentity(store, userId) {
  return store.identities.some((identity) => identity.userId === userId);
}

function findPlayerByUserId(store, userId) {
  return store.players?.find((player) => player.userId === userId) || null;
}

function ensurePlayerProfile(store, user) {
  if (!Array.isArray(store.players)) {
    store.players = [];
  }

  let player = findPlayerByUserId(store, user.id);
  const now = nowIso();
  if (!player) {
    player = {
      id: randomToken(12),
      userId: user.id,
      nickname: user.nickname || '',
      nicknameSet: Boolean(user.nicknameSet),
      inventory: null,
      stats: {},
      lastSeenAt: '',
      createdAt: now,
      updatedAt: now,
    };
    store.players.push(player);
  }

  player.nickname = user.nickname || player.nickname || '';
  player.nicknameSet = Boolean(user.nicknameSet);
  player.updatedAt = player.updatedAt || now;
  player.inventory = player.inventory ?? null;
  player.stats = player.stats && typeof player.stats === 'object' ? player.stats : {};
  player.lastSeenAt = player.lastSeenAt || '';
  return player;
}

function publicPlayer(player, includeGameData = false) {
  if (!player) {
    return null;
  }

  const result = {
    id: player.id,
    userId: player.userId,
    nickname: player.nickname || '',
    nicknameSet: Boolean(player.nicknameSet),
    stats: player.stats || {},
    lastSeenAt: player.lastSeenAt || '',
    updatedAt: player.updatedAt,
    createdAt: player.createdAt,
  };

  if (includeGameData) {
    result.inventory = player.inventory ?? null;
    result.enderChest = player.enderChest ?? null;
    result.equipment = player.equipment ?? null;
    result.location = player.location ?? null;
    result.minecraftUuid = player.minecraftUuid || '';
  }

  return result;
}

function isNicknameTaken(store, nickname, userId) {
  const lowerNickname = nickname.toLowerCase();
  return (
    store.users.some((entry) => entry.id !== userId && String(entry.nickname || '').toLowerCase() === lowerNickname)
    || (store.players || []).some((entry) => entry.userId !== userId && String(entry.nickname || '').toLowerCase() === lowerNickname)
  );
}

function setPlayerNickname(store, user, nickname) {
  const now = nowIso();
  user.nickname = nickname;
  user.nicknameSet = true;
  user.updatedAt = now;

  const player = ensurePlayerProfile(store, user);
  player.nickname = nickname;
  player.nicknameSet = true;
  player.updatedAt = now;
  return player;
}

function getPlayerByNickname(store, nickname) {
  const lowerNickname = String(nickname || '').trim().toLowerCase();
  if (!lowerNickname) {
    return null;
  }

  return (store.players || []).find((player) => String(player.nickname || '').toLowerCase() === lowerNickname) || null;
}

function upsertProviderIdentity(store, profile, linkedUserId = '') {
  const providerUserId = String(profile.providerUserId || '').trim();
  if (!providerUserId) {
    throw new Error('Provider profile has no user id.');
  }

  let identity = store.identities.find(
    (entry) => entry.provider === profile.provider && String(entry.providerUserId) === providerUserId,
  );
  let user = identity ? store.users.find((entry) => entry.id === identity.userId) : null;
  const linkedUser = linkedUserId ? store.users.find((entry) => entry.id === linkedUserId) : null;
  const displayName = profileDisplayName(profile);
  const now = nowIso();

  if (identity && linkedUser && identity.userId !== linkedUser.id) {
    throw new Error(`${profile.provider.toUpperCase()} уже привязан к другому профилю.`);
  }

  if (!user) {
    if (linkedUser) {
      user = linkedUser;
      if (typeof user.nicknameSet !== 'boolean') {
        user.nicknameSet = Boolean(user.nicknameSet);
      }
    } else {
      const userId = randomToken(16);
      const nickname = uniqueNickname(store, createNicknameCandidate(profile, providerUserId), `${profile.provider}:${providerUserId}`);
      user = {
        id: userId,
        login: getProviderLogin(userId),
        nickname,
        nicknameSet: false,
        displayName,
        avatarUrl: profile.avatarUrl || '',
        authSource: profile.provider,
        createdAt: now,
        updatedAt: now,
      };
      store.users.push(user);
    }
  }

  if (!identity) {
    identity = {
      id: randomToken(12),
      userId: user.id,
      provider: profile.provider,
      providerUserId,
      createdAt: now,
    };
    store.identities.push(identity);
  }

  identity.displayName = displayName;
  identity.avatarUrl = profile.avatarUrl || '';
  identity.profileUrl = profile.profileUrl || '';
  identity.raw = profile.raw || undefined;
  identity.updatedAt = now;

  user.displayName = user.displayName || displayName;
  user.avatarUrl = user.avatarUrl || profile.avatarUrl || '';
  user.nicknameSet = Boolean(user.nicknameSet);
  user.lastLoginAt = now;
  user.updatedAt = now;
  const player = ensurePlayerProfile(store, user);

  return { user, identity, player };
}

function publicIdentity(identity) {
  return {
    provider: identity.provider,
    providerUserId: identity.providerUserId,
    displayName: identity.displayName || '',
    avatarUrl: identity.avatarUrl || '',
    profileUrl: identity.profileUrl || '',
    linkedAt: identity.createdAt,
    updatedAt: identity.updatedAt,
  };
}

function publicUser(user, store = null) {
  const identities = store?.identities?.filter((identity) => identity.userId === user.id).map(publicIdentity) || [];
  const player = store ? findPlayerByUserId(store, user.id) : null;
  return {
    id: user.id,
    login: user.login,
    nickname: user.nickname,
    nicknameSet: Boolean(user.nicknameSet),
    displayName: user.displayName || user.nickname,
    avatarUrl: user.avatarUrl || identities.find((identity) => identity.avatarUrl)?.avatarUrl || '',
    linkedProviders: identities.map((identity) => identity.provider),
    identities,
    player: publicPlayer(player),
    createdAt: user.createdAt,
  };
}

function createEmptyStore() {
  return {
    version: 2,
    users: [],
    identities: [],
    players: [],
    sessions: [],
    oauthStates: [],
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
      identities: Array.isArray(parsed.identities) ? parsed.identities : [],
      players: Array.isArray(parsed.players) ? parsed.players : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      oauthStates: Array.isArray(parsed.oauthStates) ? parsed.oauthStates : [],
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
  store.oauthStates = store.oauthStates.filter((stateEntry) => Date.parse(stateEntry.expiresAt) > now);
  store.launcherDevices = store.launcherDevices.filter((device) => Date.parse(device.expiresAt) > now);
  store.audit = store.audit.slice(-500);
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
  if (!user || !userHasProviderIdentity(store, user.id)) {
    return null;
  }
  return { user, session };
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

function getBearerToken(request) {
  return String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

function jsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function safeGamePayload(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (jsonSize(value) > 96 * 1024) {
    return fallback;
  }

  return value;
}

function normalizeGameStats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const stats = {};
  for (const [key, rawValue] of Object.entries(value).slice(0, 80)) {
    const safeKey = String(key).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48);
    if (!safeKey) {
      continue;
    }

    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      stats[safeKey] = rawValue;
    } else if (typeof rawValue === 'string') {
      stats[safeKey] = rawValue.slice(0, 160);
    } else if (typeof rawValue === 'boolean') {
      stats[safeKey] = rawValue;
    }
  }
  return stats;
}

function updatePlayerSnapshot(store, player, snapshot) {
  const now = nowIso();
  const minecraftUuid = String(snapshot.minecraftUuid || snapshot.uuid || '').trim().slice(0, 80);
  player.minecraftUuid = minecraftUuid || player.minecraftUuid || '';
  player.inventory = safeGamePayload(snapshot.inventory, player.inventory ?? null);
  player.enderChest = safeGamePayload(snapshot.enderChest, player.enderChest ?? null);
  player.equipment = safeGamePayload(snapshot.equipment, player.equipment ?? null);
  player.location = safeGamePayload(snapshot.location, player.location ?? null);
  player.stats = {
    ...(player.stats && typeof player.stats === 'object' ? player.stats : {}),
    ...normalizeGameStats(snapshot.stats),
    online: Boolean(snapshot.online),
  };
  player.lastSeenAt = now;
  player.updatedAt = now;

  const user = player.userId ? store.users.find((entry) => entry.id === player.userId) : null;
  if (user) {
    user.lastSeenAt = now;
    user.updatedAt = now;
  }
  return player;
}

function requireVkConfig(reply) {
  if (!vkClientId) {
    return reply.code(503).send({ ok: false, error: 'VK ID пока не настроен на сервере.' });
  }
  return null;
}

function requireTelegramConfig(reply) {
  if (!telegramClientId || !telegramClientSecret) {
    return reply.code(503).send({ ok: false, error: 'Telegram пока не настроен на сервере.' });
  }
  return null;
}

function redirectWithError(reply, message, returnTo = '/#account') {
  const url = new URL(getSafeReturnPath(returnTo), publicOrigin);
  url.searchParams.set('auth_error', message);
  return reply.redirect(url.toString());
}

async function vkFetchJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'flexcraft-auth/1.0',
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const details = payload.error_description || payload.error || `VK ID HTTP ${response.status}`;
    const error = new Error(String(details));
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function exchangeVkCode({ code, deviceId, codeVerifier, state }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: vkRedirectUri,
    client_id: vkClientId,
    code_verifier: codeVerifier,
    state,
    device_id: deviceId,
  });
  if (vkClientSecret) {
    body.set('client_secret', vkClientSecret);
  }
  return vkFetchJson(`${vkBaseUrl}/oauth2/auth`, body);
}

async function fetchVkProfile(accessToken) {
  const body = new URLSearchParams({ client_id: vkClientId, access_token: accessToken });
  const result = await vkFetchJson(`${vkBaseUrl}/oauth2/user_info`, body);
  const user = result.user || {};
  const providerUserId = String(user.user_id || user.id || result.user_id || '').trim();
  if (!providerUserId) {
    throw new Error('VK ID не вернул идентификатор пользователя.');
  }

  return {
    provider: 'vk',
    providerUserId,
    first_name: user.first_name,
    last_name: user.last_name,
    displayName: [user.first_name, user.last_name].map(normalizeDisplayName).filter(Boolean).join(' '),
    avatarUrl: String(user.avatar || user.photo || user.photo_200 || '').trim(),
    profileUrl: `https://vk.com/id${providerUserId}`,
    raw: {
      user_id: providerUserId,
      first_name: user.first_name,
      last_name: user.last_name,
      avatar: user.avatar || user.photo || user.photo_200 || '',
    },
  };
}

function decodeJwtPart(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

async function fetchTelegramJwks() {
  if (telegramJwksCache.expiresAt > Date.now() && telegramJwksCache.keys.length > 0) {
    return telegramJwksCache.keys;
  }

  const response = await fetch(telegramJwksUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'flexcraft-auth/1.0',
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(payload.keys)) {
    throw new Error(`Telegram JWKS HTTP ${response.status}`);
  }

  telegramJwksCache = {
    keys: payload.keys,
    expiresAt: Date.now() + 1000 * 60 * 60,
  };
  return telegramJwksCache.keys;
}

async function verifyTelegramIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) {
    throw new Error('Telegram вернул некорректный id_token.');
  }

  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  if (header.alg !== 'RS256') {
    throw new Error('Telegram вернул неподдерживаемую подпись id_token.');
  }

  const keys = await fetchTelegramJwks();
  const jwk = keys.find((entry) => entry.kid === header.kid) || keys.find((entry) => entry.kty === 'RSA');
  if (!jwk) {
    throw new Error('Не найден ключ подписи Telegram.');
  }

  const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
  const signed = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2], 'base64url');
  const validSignature = verify('RSA-SHA256', Buffer.from(signed), publicKey, signature);
  if (!validSignature) {
    telegramJwksCache = { keys: [], expiresAt: 0 };
    throw new Error('Telegram id_token не прошёл проверку подписи.');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.iss !== telegramIssuer) {
    throw new Error('Telegram вернул неожиданный issuer.');
  }
  const audience = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud || '')];
  if (!audience.includes(telegramClientId)) {
    throw new Error('Telegram вернул токен для другого приложения.');
  }
  if (Number(payload.exp || 0) <= nowSeconds) {
    throw new Error('Telegram id_token устарел.');
  }
  const providerUserId = String(payload.sub || payload.id || '').trim();
  if (!providerUserId) {
    throw new Error('Telegram не вернул идентификатор пользователя.');
  }

  const username = normalizeDisplayName(payload.username || payload.preferred_username || '');
  const firstName = normalizeDisplayName(payload.given_name || payload.first_name || '');
  const lastName = normalizeDisplayName(payload.family_name || payload.last_name || '');
  const displayName = normalizeDisplayName(payload.name || [firstName, lastName].filter(Boolean).join(' ') || username);

  return {
    provider: 'telegram',
    providerUserId,
    first_name: firstName,
    last_name: lastName,
    displayName,
    avatarUrl: String(payload.picture || payload.photo_url || '').trim(),
    profileUrl: username ? `https://t.me/${username.replace(/^@/, '')}` : '',
    raw: {
      sub: providerUserId,
      username,
      name: displayName,
      picture: payload.picture || payload.photo_url || '',
    },
  };
}

async function exchangeTelegramCode({ code, codeVerifier }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: telegramRedirectUri,
    client_id: telegramClientId,
    code_verifier: codeVerifier,
  });
  const basicCredentials = Buffer.from(`${telegramClientId}:${telegramClientSecret}`, 'utf8').toString('base64');

  const response = await fetch(telegramTokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Basic ${basicCredentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'flexcraft-auth/1.0',
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error || !payload.id_token) {
    const details = payload.error_description || payload.error || `Telegram HTTP ${response.status}`;
    const error = new Error(String(details));
    error.payload = payload;
    throw error;
  }
  return payload;
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

app.get('/api/auth/providers', async () => ({ ok: true, providers: getProviderStatus() }));

app.get('/api/auth/me', async (request, reply) => {
  const session = await getSessionUser(request);
  if (!session?.user) {
    clearSessionCookie(reply);
    return { ok: true, user: null, providers: getProviderStatus() };
  }

  const store = await loadStore();
  cleanupStore(store);
  const user = store.users.find((entry) => entry.id === session.user.id) || session.user;
  return { ok: true, user: publicUser(user, store), providers: getProviderStatus() };
});

app.get('/api/player/me', async (request, reply) => {
  const session = await getSessionUser(request);
  if (!session?.user) {
    clearSessionCookie(reply);
    return reply.code(401).send({ ok: false, error: 'Войдите через VK ID или Telegram, чтобы открыть профиль игрока.' });
  }

  return mutateStore(async (store) => {
    const user = store.users.find((entry) => entry.id === session.user.id) || session.user;
    const player = ensurePlayerProfile(store, user);
    return reply.send({ ok: true, user: publicUser(user, store), player: publicPlayer(player, true) });
  });
});

app.post('/api/player/nickname', async (request, reply) => {
  const session = await getSessionUser(request);
  if (!session?.user) {
    clearSessionCookie(reply);
    return reply.code(401).send({ ok: false, error: 'Войдите через VK ID или Telegram, чтобы выбрать игровой ник.' });
  }

  const validated = validatePlayerNickname(request.body?.nickname);
  if (validated.error) {
    return badRequest(reply, validated.error);
  }

  return mutateStore(async (store) => {
    const user = store.users.find((entry) => entry.id === session.user.id);
    if (!user || !userHasProviderIdentity(store, user.id)) {
      return reply.code(401).send({ ok: false, error: 'Сессия устарела. Войдите ещё раз.' });
    }
    if (user.nicknameSet) {
      return reply.code(409).send({ ok: false, error: 'Игровой ник уже выбран и больше не меняется.' });
    }

    if (isNicknameTaken(store, validated.nickname, user.id)) {
      return reply.code(409).send({ ok: false, error: 'Этот ник уже занят. Выберите другой.' });
    }

    const player = setPlayerNickname(store, user, validated.nickname);
    addAudit(store, 'player.nickname_update', request, { userId: user.id, nickname: validated.nickname });
    return reply.send({ ok: true, user: publicUser(user, store), player: publicPlayer(player, true) });
  });
});

app.post('/api/game/player/snapshot', async (request, reply) => {
  if (!gameApiToken) {
    return reply.code(503).send({ ok: false, error: 'GAME_API_TOKEN не настроен на сервере.' });
  }

  if (getBearerToken(request) !== gameApiToken) {
    return reply.code(401).send({ ok: false, error: 'Неверный токен игрового сервера.' });
  }

  const validated = validatePlayerNickname(request.body?.nickname);
  if (validated.error) {
    return badRequest(reply, validated.error);
  }

  return mutateStore(async (store) => {
    const player = getPlayerByNickname(store, validated.nickname);
    if (!player || !player.nicknameSet) {
      return reply.code(404).send({ ok: false, error: 'Игрок с таким ником не найден в базе сайта.' });
    }

    updatePlayerSnapshot(store, player, request.body || {});
    addAudit(store, 'game.player_snapshot', request, { userId: player.userId, nickname: player.nickname });
    return reply.send({ ok: true, player: publicPlayer(player, true) });
  });
});

app.get('/api/auth/vk/start', async (request, reply) => {
  const configError = requireVkConfig(reply);
  if (configError) {
    return configError;
  }

  const state = randomToken(32);
  const codeVerifier = randomToken(64);
  const returnTo = getRequestReturnPath(request);
  const session = await getSessionUser(request);
  await mutateStore(async (store) => {
    store.oauthStates.push({
      id: randomToken(8),
      provider: 'vk',
      stateHash: sha256(state),
      codeVerifier,
      returnTo,
      linkUserId: session?.user?.id || '',
      createdAt: nowIso(),
      expiresAt: isoIn(oauthStateTtlMs),
    });
    addAudit(store, 'auth.vk_start', request, { linkUserId: session?.user?.id || '' });
  });

  const authorizeUrl = new URL(`${vkBaseUrl}/authorize`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', vkClientId);
  authorizeUrl.searchParams.set('app_id', vkClientId);
  authorizeUrl.searchParams.set('redirect_uri', vkRedirectUri);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('scope', vkScope);
  authorizeUrl.searchParams.set('vk_id_provider', 'vkid');
  authorizeUrl.searchParams.set('prompt', 'select_account');
  authorizeUrl.searchParams.set('lang_id', '0');

  return reply.redirect(authorizeUrl.toString());
});

app.get('/api/auth/vk/callback', async (request, reply) => {
  const configError = requireVkConfig(reply);
  if (configError) {
    return configError;
  }

  const code = String(request.query?.code || '').trim();
  const state = String(request.query?.state || '').trim();
  const deviceId = String(request.query?.device_id || '').trim();
  const oauthError = String(request.query?.error_description || request.query?.error || '').trim();

  if (oauthError) {
    return redirectWithError(reply, oauthError);
  }
  if (!code || !state || !deviceId) {
    return redirectWithError(reply, 'VK ID вернул неполный ответ.');
  }

  const stateHash = sha256(state);
  const store = await loadStore();
  cleanupStore(store);
  const stateEntry = store.oauthStates.find((entry) => entry.provider === 'vk' && entry.stateHash === stateHash);
  if (!stateEntry || Date.parse(stateEntry.expiresAt) <= Date.now()) {
    return redirectWithError(reply, 'Сессия входа VK устарела. Попробуйте ещё раз.');
  }

  try {
    const tokenResult = await exchangeVkCode({
      code,
      deviceId,
      codeVerifier: stateEntry.codeVerifier,
      state,
    });
    const profile = await fetchVkProfile(tokenResult.access_token);

    return mutateStore(async (nextStore) => {
      nextStore.oauthStates = nextStore.oauthStates.filter((entry) => entry.id !== stateEntry.id);
      const { user, identity } = upsertProviderIdentity(nextStore, profile, stateEntry.linkUserId || '');
      const sessionToken = await createSession(nextStore, user, { kind: 'web', provider: 'vk' });
      addAudit(nextStore, stateEntry.linkUserId ? 'auth.vk_link' : 'auth.vk_login', request, {
        userId: user.id,
        identityId: identity.id,
      });
      setSessionCookie(reply, sessionToken);
      return reply.redirect(new URL(getSafeReturnPath(stateEntry.returnTo), publicOrigin).toString());
    });
  } catch (error) {
    app.log.warn({ error: error.message, payload: error.payload }, 'VK ID callback failed.');
    await mutateStore(async (nextStore) => {
      nextStore.oauthStates = nextStore.oauthStates.filter((entry) => entry.id !== stateEntry.id);
      addAudit(nextStore, 'auth.vk_failed', request, { error: error.message });
    });
    return redirectWithError(reply, 'Не удалось войти через VK. Попробуйте ещё раз.', stateEntry.returnTo);
  }
});

app.get('/api/auth/telegram/start', async (request, reply) => {
  const configError = requireTelegramConfig(reply);
  if (configError) {
    return configError;
  }

  const state = randomToken(32);
  const codeVerifier = randomToken(64);
  const returnTo = getRequestReturnPath(request);
  const session = await getSessionUser(request);
  await mutateStore(async (store) => {
    store.oauthStates.push({
      id: randomToken(8),
      provider: 'telegram',
      stateHash: sha256(state),
      codeVerifier,
      returnTo,
      linkUserId: session?.user?.id || '',
      createdAt: nowIso(),
      expiresAt: isoIn(oauthStateTtlMs),
    });
    addAudit(store, 'auth.telegram_start', request, { linkUserId: session?.user?.id || '' });
  });

  const authorizeUrl = new URL(telegramAuthorizeUrl);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('client_id', telegramClientId);
  authorizeUrl.searchParams.set('redirect_uri', telegramRedirectUri);
  authorizeUrl.searchParams.set('scope', telegramScope);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');

  return reply.redirect(authorizeUrl.toString());
});

app.get('/api/auth/telegram/callback', async (request, reply) => {
  const configError = requireTelegramConfig(reply);
  if (configError) {
    return configError;
  }

  const code = String(request.query?.code || '').trim();
  const state = String(request.query?.state || '').trim();
  const oauthError = String(request.query?.error_description || request.query?.error || '').trim();

  if (oauthError) {
    return redirectWithError(reply, oauthError);
  }
  if (!code || !state) {
    return redirectWithError(reply, 'Telegram вернул неполный ответ.');
  }

  const stateHash = sha256(state);
  const store = await loadStore();
  cleanupStore(store);
  const stateEntry = store.oauthStates.find((entry) => entry.provider === 'telegram' && entry.stateHash === stateHash);
  if (!stateEntry || Date.parse(stateEntry.expiresAt) <= Date.now()) {
    return redirectWithError(reply, 'Сессия входа Telegram устарела. Попробуйте ещё раз.');
  }

  try {
    const tokenResult = await exchangeTelegramCode({
      code,
      codeVerifier: stateEntry.codeVerifier,
    });
    const profile = await verifyTelegramIdToken(tokenResult.id_token);

    return mutateStore(async (nextStore) => {
      nextStore.oauthStates = nextStore.oauthStates.filter((entry) => entry.id !== stateEntry.id);
      const { user, identity } = upsertProviderIdentity(nextStore, profile, stateEntry.linkUserId || '');
      const sessionToken = await createSession(nextStore, user, { kind: 'web', provider: 'telegram' });
      addAudit(nextStore, stateEntry.linkUserId ? 'auth.telegram_link' : 'auth.telegram_login', request, {
        userId: user.id,
        identityId: identity.id,
      });
      setSessionCookie(reply, sessionToken);
      return reply.redirect(new URL(getSafeReturnPath(stateEntry.returnTo), publicOrigin).toString());
    });
  } catch (error) {
    app.log.warn({ error: error.message, payload: error.payload }, 'Telegram callback failed.');
    await mutateStore(async (nextStore) => {
      nextStore.oauthStates = nextStore.oauthStates.filter((entry) => entry.id !== stateEntry.id);
      addAudit(nextStore, 'auth.telegram_failed', request, { error: error.message });
    });
    return redirectWithError(reply, 'Не удалось войти через Telegram. Попробуйте ещё раз.', stateEntry.returnTo);
  }
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

app.post('/api/launcher/device/start', async (request) => {
  const deviceCode = randomToken(32);
  await mutateStore(async (store) => {
    store.launcherDevices.push({
      id: randomToken(8),
      deviceCodeHash: sha256(deviceCode),
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
    verificationUri: `${publicOrigin}/launcher/link`,
    verificationUriComplete: `${publicOrigin}/launcher/link?device=${encodeURIComponent(deviceCode)}`,
    expiresIn: Math.floor(launcherDeviceTtlMs / 1000),
    interval: launcherPollIntervalSeconds,
  };
});

app.post('/api/launcher/device/approve', async (request, reply) => {
  const session = await getSessionUser(request);
  if (!session?.user) {
    return reply.code(401).send({ ok: false, error: 'Войдите на сайте, чтобы подключить лаунчер.' });
  }
  if (!session.user.nicknameSet) {
    return reply.code(409).send({ ok: false, error: 'Сначала выберите игровой ник в профиле сайта.' });
  }

  const deviceCode = String(request.body?.deviceCode || '').trim();
  if (deviceCode.length < 20) {
    return badRequest(reply, 'Нет подключения лаунчера.');
  }

  return mutateStore(async (store) => {
    const device = store.launcherDevices.find((entry) => entry.deviceCodeHash === sha256(deviceCode));
    if (!device || Date.parse(device.expiresAt) <= Date.now()) {
      return reply.code(404).send({ ok: false, error: 'Подключение лаунчера не найдено или устарело.' });
    }
    if (device.status !== 'pending') {
      return reply.code(409).send({ ok: false, error: 'Это подключение уже использовано.' });
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
    if (!user || !userHasProviderIdentity(store, user.id)) {
      return reply.code(400).send({ ok: false, status: 'denied', error: 'Пользователь не найден.' });
    }
    if (!user.nicknameSet) {
      return reply.code(409).send({ ok: false, status: 'denied', error: 'Сначала выберите игровой ник на сайте.' });
    }

    const launcherToken = await createSession(store, user, { kind: 'launcher' });
    device.status = 'used';
    device.usedAt = nowIso();
    addAudit(store, 'launcher.device_complete', request, { userId: user.id });
    return reply.send({ ok: true, status: 'approved', token: launcherToken, user: publicUser(user, store) });
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
  if (!user || !userHasProviderIdentity(store, user.id)) {
    return reply.code(401).send({ ok: false, error: 'Сессия лаунчера истекла.' });
  }
  if (!user.nicknameSet) {
    return reply.code(409).send({ ok: false, error: 'Сначала выберите игровой ник на сайте.' });
  }

  return { ok: true, user: publicUser(user, store) };
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
