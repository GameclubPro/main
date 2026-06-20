import { createHash } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { access, appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as tar from 'tar';
import { unzipSync } from 'fflate';

const VERSION_MANIFEST_URLS = [
  'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json',
  'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
] as const;
const BASE_MINECRAFT_VERSION = '26.1.2';
const FABRIC_LOADER_VERSION = '0.19.2';
const DEFAULT_RELEASE_VERSION = `fabric-loader-${FABRIC_LOADER_VERSION}-${BASE_MINECRAFT_VERSION}`;
const DEFAULT_SERVER_ADDRESS = 'flex-craft.ru:25565';
const LEGACY_LOCAL_SERVER_ADDRESSES = new Set(['127.0.0.1', '127.0.0.1:25565', 'localhost', 'localhost:25565']);
const DEFAULT_SERVER_NAME = 'FlexCraft';
const DEFAULT_MINECRAFT_OPTIONS: Record<string, string> = {
  lang: 'ru_ru',
  narrator: '0',
  narratorHotkey: 'false',
  onboardAccessibility: 'false',
  skipMultiplayerWarning: 'true',
  skipRealms32bitWarning: 'true',
  telemetryOptInExtra: 'false',
  tutorialStep: 'none',
};
const DEFAULT_MINECRAFT_KEY_OPTIONS: Record<string, string> = {
  'key_gui.xaero_open_map': 'key.keyboard.m',
  'key_gui.xaero_pac_key_open_menu': 'key.keyboard.p',
};
const BUNDLED_CLIENT_MODS_DIR = 'client-mods';
const BUNDLED_MODPACK_META_FILE = '.craftgate-client-mods.json';
const REMOTE_CLIENT_MODS_BASE_URLS = [
  'https://flex-craft.ru/client-mods',
  'https://www.flex-craft.ru/client-mods',
] as const;
const AUTH_API_BASE_URL = 'https://flex-craft.ru/api';
const LOG_RETENTION = 160;
const USER_AGENT = `flexcraft-launcher/0.1 (${process.platform}; ${process.arch})`;
const REQUIRED_JAVA_MAJOR_VERSION = 25;
const DOWNLOAD_IDLE_TIMEOUT_MS = 45_000;
const MIN_LIBRARY_ARTIFACT_BYTES = 4096;

export type JavaSource = 'bundled' | 'custom' | 'system' | 'missing';

export interface LauncherConfig {
  username: string;
  serverAddress: string;
  javaExecutable: string;
  useBundledJava: boolean;
  minMemoryMb: number;
  maxMemoryMb: number;
  preferredVersion: string;
}

export interface LauncherAccountFile {
  launcherAuth?: StoredLauncherAuth | null;
}

export interface AuthSession {
  accountId: string;
  login: string;
  username: string;
  source?: 'flexcraft';
}

export interface StoredLauncherAuth {
  token: string;
  user: FlexCraftUser;
  createdAt: string;
}

export interface FlexCraftUser {
  id: string;
  login: string;
  nickname: string;
  createdAt?: string;
}

export interface LauncherDeviceStart {
  deviceCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

export interface LauncherDevicePoll {
  status: 'pending' | 'approved' | 'expired' | 'denied';
  token?: string;
  user?: FlexCraftUser;
  interval?: number;
}

export interface LauncherProgress {
  stage: string;
  current: number;
  total: number;
  percent: number;
  detail: string;
}

export interface LauncherStatus {
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

export interface LauncherSnapshot {
  config: LauncherConfig;
  status: LauncherStatus;
  session: AuthSession | null;
}

interface LauncherPaths {
  rootDir: string;
  configPath: string;
  authPath: string;
  legacyAccountsPath: string;
  cacheDir: string;
  manifestsDir: string;
  downloadsDir: string;
  runtimeDir: string;
  gameDir: string;
  versionsDir: string;
  librariesDir: string;
  assetsDir: string;
  nativesDir: string;
  logsDir: string;
  launcherLogPath: string;
}

interface VersionManifestIndex {
  latest: {
    release: string;
    snapshot: string;
  };
  versions: Array<{
    id: string;
    type: string;
    url: string;
    sha1?: string;
    time?: string;
    releaseTime?: string;
  }>;
}

interface RuleDescriptor {
  action: 'allow' | 'deny';
  os?: {
    name?: 'linux' | 'windows' | 'osx';
    arch?: string;
    versionRange?: {
      min?: string;
      max?: string;
    };
  };
  features?: Record<string, boolean>;
}

interface ArgumentDescriptor {
  rules?: RuleDescriptor[];
  value: string | string[];
}

interface LibraryArtifact {
  path: string;
  sha1?: string;
  size?: number;
  url: string;
}

interface VersionFile {
  id: string;
  type: string;
  mainClass: string;
  arguments?: {
    game?: Array<string | ArgumentDescriptor>;
    jvm?: Array<string | ArgumentDescriptor>;
    'default-user-jvm'?: Array<string | ArgumentDescriptor>;
  };
  assetIndex: {
    id: string;
    sha1: string;
    size: number;
    totalSize?: number;
    url: string;
  };
  downloads: {
    client: LibraryArtifact;
  };
  libraries: Array<{
    name: string;
    downloads?: {
      artifact?: LibraryArtifact;
      classifiers?: Record<string, LibraryArtifact>;
    };
    natives?: Record<string, string>;
    rules?: RuleDescriptor[];
    extract?: {
      exclude?: string[];
    };
  }>;
  logging?: {
    client?: {
      argument: string;
      file: LibraryArtifact & { id: string };
      type: string;
    };
  };
  javaVersion?: {
    component: string;
    majorVersion: number;
  };
}

interface AssetIndexFile {
  objects: Record<string, { hash: string; size: number }>;
}

interface RuntimePackageDescriptor {
  checksum: string;
  link: string;
  name: string;
  size: number;
}

interface RuntimeApiAsset {
  binary?: {
    package?: RuntimePackageDescriptor;
  };
  package?: RuntimePackageDescriptor;
}

interface DownloadJob {
  url: string;
  urls?: readonly string[];
  destination: string;
  expectedSha1?: string;
  expectedSha256?: string;
  expectedSize?: number;
  minimumSize?: number;
}

interface LaunchContext {
  version: VersionFile;
  javaPath: string;
  javaSource: JavaSource;
}

interface ClientModpackMod {
  file?: string;
  sha1?: string;
  sha256?: string;
  size?: number;
  slug?: string;
  title?: string;
  version?: string;
}

interface ApiEnvelope<T> {
  ok?: boolean;
  error?: string;
  user?: FlexCraftUser;
  status?: LauncherDevicePoll['status'];
  token?: string;
  deviceCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresIn?: number;
  interval?: number;
}

interface ResolvedClientMod extends ClientModpackMod {
  file: string;
}

interface BundledModpackMeta {
  source?: string;
  updatedAt?: string;
  syncedAt?: string;
  mods?: ClientModpackMod[];
}

function defaultConfig(): LauncherConfig {
  return {
    username: 'FlexCraft',
    serverAddress: DEFAULT_SERVER_ADDRESS,
    javaExecutable: '',
    useBundledJava: true,
    minMemoryMb: 2048,
    maxMemoryMb: 4096,
    preferredVersion: DEFAULT_RELEASE_VERSION,
  };
}

function toConfigObject(input: unknown): Partial<LauncherConfig> {
  return input && typeof input === 'object' ? (input as Partial<LauncherConfig>) : {};
}

function coerceString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeManagedModFileName(raw: unknown): string | null {
  const fileName = coerceString(raw).trim();

  if (!fileName || fileName === '.' || fileName === '..') {
    return null;
  }

  if (fileName.includes('/') || fileName.includes('\\') || fileName.includes(':') || fileName.includes('\0')) {
    return null;
  }

  if (path.isAbsolute(fileName) || /^[a-z]:/i.test(fileName)) {
    return null;
  }

  return fileName;
}

function normalizeHexDigest(raw: unknown, length: number): string | undefined {
  const digest = coerceString(raw).trim().toLowerCase();
  return new RegExp(`^[a-f0-9]{${length}}$`).test(digest) ? digest : undefined;
}

function normalizePositiveInteger(raw: unknown): number | undefined {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function normalizeModpackMods(meta: BundledModpackMeta): ResolvedClientMod[] {
  const modsByFile = new Map<string, ResolvedClientMod>();

  for (const rawMod of meta.mods ?? []) {
    if (!rawMod || typeof rawMod !== 'object') {
      continue;
    }

    const file = normalizeManagedModFileName(rawMod.file);
    if (!file || !file.toLowerCase().endsWith('.jar')) {
      continue;
    }

    const mod: ResolvedClientMod = { ...rawMod, file };
    const sha1 = normalizeHexDigest(rawMod.sha1, 40);
    const sha256 = normalizeHexDigest(rawMod.sha256, 64);
    const size = normalizePositiveInteger(rawMod.size);

    if (sha1) {
      mod.sha1 = sha1;
    } else {
      delete mod.sha1;
    }

    if (sha256) {
      mod.sha256 = sha256;
    } else {
      delete mod.sha256;
    }

    if (size) {
      mod.size = size;
    } else {
      delete mod.size;
    }

    modsByFile.set(file, mod);
  }

  return [...modsByFile.values()];
}

function maxRecommendedMemoryMb(): number {
  const totalMemoryMb = Math.floor(os.totalmem() / 1024 / 1024);
  const usableMemoryMb = Math.floor(totalMemoryMb * 0.75);
  return Math.max(2048, Math.min(8192, usableMemoryMb));
}

function sanitizeConfig(input: Partial<LauncherConfig> | LauncherConfig | unknown): LauncherConfig {
  const merged = { ...defaultConfig(), ...toConfigObject(input) };
  const minMemoryValue = Number(merged.minMemoryMb);
  const maxMemoryValue = Number(merged.maxMemoryMb);
  const memoryLimitMb = maxRecommendedMemoryMb();
  const minMemoryMb = Number.isFinite(minMemoryValue)
    ? Math.min(memoryLimitMb, Math.max(1024, Math.floor(minMemoryValue)))
    : Math.min(2048, memoryLimitMb);
  const maxMemoryMb = Number.isFinite(maxMemoryValue)
    ? Math.min(memoryLimitMb, Math.max(minMemoryMb, Math.floor(maxMemoryValue)))
    : Math.min(memoryLimitMb, Math.max(4096, minMemoryMb));

  return {
    username: sanitizeUsername(merged.username),
    serverAddress: sanitizeServerAddress(merged.serverAddress),
    javaExecutable: coerceString(merged.javaExecutable).trim(),
    useBundledJava: Boolean(merged.useBundledJava),
    minMemoryMb,
    maxMemoryMb,
    preferredVersion: sanitizePreferredVersion(merged.preferredVersion),
  };
}

function sanitizePreferredVersion(raw: unknown): string {
  const version = coerceString(raw).trim().slice(0, 120);

  if (!version || version === BASE_MINECRAFT_VERSION) {
    return DEFAULT_RELEASE_VERSION;
  }

  return version;
}

function sanitizeServerAddress(raw: unknown): string {
  const address = coerceString(raw).trim().slice(0, 255);

  if (!address || LEGACY_LOCAL_SERVER_ADDRESSES.has(address.toLowerCase())) {
    return DEFAULT_SERVER_ADDRESS;
  }

  return address;
}

function splitServerAddress(serverAddress: string): { host: string; port: string } | null {
  const address = serverAddress.trim();

  if (!address) {
    return null;
  }

  const defaultPort = '25565';
  const ipv6Match = address.match(/^\[([^\]]+)](?::(\d{1,5}))?$/);
  if (ipv6Match) {
    return { host: ipv6Match[1], port: normalizeServerPort(ipv6Match[2] ?? defaultPort) };
  }

  const lastColonIndex = address.lastIndexOf(':');
  if (lastColonIndex > 0 && address.indexOf(':') === lastColonIndex) {
    return {
      host: address.slice(0, lastColonIndex),
      port: normalizeServerPort(address.slice(lastColonIndex + 1) || defaultPort),
    };
  }

  return { host: address, port: defaultPort };
}

function normalizeServerPort(rawPort: string): string {
  const port = Number(rawPort);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? String(port) : '25565';
}

function sanitizeUsername(raw: unknown): string {
  const cleaned = coerceString(raw).trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  return cleaned || 'FlexCraft';
}

function sanitizeLogin(raw: unknown): string {
  return coerceString(raw).trim().toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 32);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function flexUserToSession(user: FlexCraftUser): AuthSession {
  return {
    accountId: user.id,
    login: user.login,
    username: sanitizeUsername(user.nickname || user.login),
    source: 'flexcraft',
  };
}

function sanitizeFlexCraftUser(raw: unknown): FlexCraftUser | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const user = raw as Partial<FlexCraftUser>;
  const id = coerceString(user.id).trim();
  const login = sanitizeLogin(user.login);
  const nickname = sanitizeUsername(user.nickname || user.login);

  if (!id || login.length < 3 || nickname.length < 3) {
    return null;
  }

  return {
    id,
    login,
    nickname,
    createdAt: coerceString(user.createdAt).trim() || undefined,
  };
}

function sanitizeStoredLauncherAuth(raw: unknown): StoredLauncherAuth | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const auth = raw as Partial<StoredLauncherAuth>;
  const token = coerceString(auth.token).trim();
  const user = sanitizeFlexCraftUser(auth.user);
  const createdAt = coerceString(auth.createdAt).trim() || new Date().toISOString();

  if (token.length < 20 || !user) {
    return null;
  }

  return { token, user, createdAt };
}

function sanitizeStoredSession(launcherAuth?: StoredLauncherAuth | null): AuthSession | null {
  if (launcherAuth?.user) {
    return flexUserToSession(launcherAuth.user);
  }

  return null;
}

async function fetchApi<T>(pathName: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  let body: string | undefined;

  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  const response = await fetch(`${AUTH_API_BASE_URL}${pathName}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  });
  const payload = (await response.json().catch(() => ({}))) as ApiEnvelope<T>;

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `FlexCraft API ${response.status}`);
  }

  return payload as T;
}

function minecraftOsName(): 'linux' | 'windows' | 'osx' {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'osx';
    default:
      return 'linux';
  }
}

function currentArchCandidates(): string[] {
  switch (process.arch) {
    case 'ia32':
      return ['x86', '32', 'ia32'];
    case 'arm64':
      return ['arm64', 'aarch64'];
    default:
      return ['x64', 'x86_64', 'amd64', '64'];
  }
}

function nativeArtifactMatchesCurrentArch(artifactPath: string): boolean {
  const normalized = artifactPath.toLowerCase().replace(/\\/g, '/');

  if (!normalized.includes('natives-')) {
    return false;
  }

  if (process.platform === 'win32') {
    if (!normalized.includes('natives-windows')) {
      return false;
    }
    if (normalized.includes('natives-windows-arm64')) {
      return process.arch === 'arm64';
    }
    if (normalized.includes('natives-windows-x86')) {
      return process.arch === 'ia32';
    }
    return true;
  }

  if (process.platform === 'darwin') {
    if (!normalized.includes('natives-macos')) {
      return false;
    }
    if (normalized.includes('natives-macos-arm64')) {
      return process.arch === 'arm64';
    }
    return process.arch !== 'arm64';
  }

  return normalized.includes('natives-linux');
}

function nativeEntryMatchesCurrentArch(entryName: string): boolean {
  const normalized = entryName.toLowerCase().replace(/\\/g, '/');

  if (process.platform === 'win32') {
    if (normalized.startsWith('windows/x64/') || normalized.startsWith('windows/amd64/')) {
      return process.arch === 'x64';
    }
    if (normalized.startsWith('windows/x86/') || normalized.startsWith('windows/ia32/')) {
      return process.arch === 'ia32';
    }
    if (normalized.startsWith('windows/arm64/') || normalized.startsWith('windows/aarch64/')) {
      return process.arch === 'arm64';
    }
  }

  return true;
}

function nativeEntryOutputName(entryName: string): string | null {
  if (!/\.(dll|dylib|jnilib|so)$/i.test(entryName)) {
    return null;
  }

  if (!nativeEntryMatchesCurrentArch(entryName)) {
    return null;
  }

  return entryName.replace(/\\/g, '/').split('/').pop() ?? null;
}

function isMemoryArgument(argument: string): boolean {
  return /^-Xm[sx]/i.test(argument);
}

function isGarbageCollectorFlag(argument: string): boolean {
  return /^-XX:\+Use(?:G1|Z|Shenandoah|Serial|Parallel)GC$/i.test(argument);
}

function normalizeJvmArguments(args: string[]): string[] {
  const preferredGcFlag = args.includes('-XX:+UseZGC')
    ? '-XX:+UseZGC'
    : args.reduce<string | null>((selected, argument) => (isGarbageCollectorFlag(argument) ? argument : selected), null);

  return args.filter((argument) => {
    if (isGarbageCollectorFlag(argument)) {
      return !preferredGcFlag || argument === preferredGcFlag;
    }

    if (preferredGcFlag === '-XX:+UseZGC') {
      return !/^-XX:(?:G1|MaxGCPauseMillis=|\+UnlockExperimentalVMOptions$)/.test(argument);
    }

    return true;
  });
}

export function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[^0-9]+/).filter(Boolean).map(Number);
  const rightParts = right.split(/[^0-9]+/).filter(Boolean).map(Number);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;

    if (a !== b) {
      return a < b ? -1 : 1;
    }
  }

  return 0;
}

function matchesRule(rule: RuleDescriptor, features: Record<string, boolean>): boolean {
  if (rule.os) {
    if (rule.os.name && rule.os.name !== minecraftOsName()) {
      return false;
    }

    if (rule.os.arch) {
      const allowedArch = currentArchCandidates().includes(rule.os.arch);
      if (!allowedArch) {
        return false;
      }
    }

    if (rule.os.versionRange && process.platform === 'win32') {
      const currentVersion = os.release();
      if (rule.os.versionRange.min && compareVersions(currentVersion, rule.os.versionRange.min) < 0) {
        return false;
      }
      if (rule.os.versionRange.max && compareVersions(currentVersion, rule.os.versionRange.max) > 0) {
        return false;
      }
    }
  }

  if (rule.features) {
    for (const [key, value] of Object.entries(rule.features)) {
      if ((features[key] ?? false) !== value) {
        return false;
      }
    }
  }

  return true;
}

function isAllowedByRules(rules: RuleDescriptor[] | undefined, features: Record<string, boolean> = {}): boolean {
  if (!rules || rules.length === 0) {
    return true;
  }

  let allowed = false;
  for (const rule of rules) {
    if (matchesRule(rule, features)) {
      allowed = rule.action === 'allow';
    }
  }

  return allowed;
}

function substituteVariables(value: string, variables: Record<string, string>): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, key: string) => variables[key] ?? '');
}

function expandArguments(
  entries: Array<string | ArgumentDescriptor> | undefined,
  variables: Record<string, string>,
  features: Record<string, boolean>,
): string[] {
  if (!entries) {
    return [];
  }

  const expanded: string[] = [];

  for (const entry of entries) {
    if (typeof entry === 'string') {
      expanded.push(substituteVariables(entry, variables));
      continue;
    }

    if (!isAllowedByRules(entry.rules, features)) {
      continue;
    }

    const values = Array.isArray(entry.value) ? entry.value : [entry.value];
    for (const value of values) {
      expanded.push(substituteVariables(value, variables));
    }
  }

  return expanded;
}

function toOfflineUuid(username: string): string {
  const hash = createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parseMinecraftOptions(content: string): Map<string, string> {
  const options = new Map<string, string>();

  for (const line of content.split(/\r?\n/)) {
    const separatorIndex = line.indexOf(':');

    if (separatorIndex <= 0) {
      continue;
    }

    options.set(line.slice(0, separatorIndex), line.slice(separatorIndex + 1));
  }

  return options;
}

function serializeMinecraftOptions(options: Map<string, string>): string {
  return `${[...options.entries()].map(([key, value]) => `${key}:${value}`).join('\n')}\n`;
}

async function fileIsRegularFile(targetPath: string): Promise<boolean> {
  try {
    return (await stat(targetPath)).isFile();
  } catch {
    return false;
  }
}

async function ensureDirectory(targetPath: string): Promise<void> {
  try {
    const targetStat = await stat(targetPath);
    if (targetStat.isDirectory()) {
      return;
    }

    await rename(targetPath, `${targetPath}.broken-${Date.now()}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  await mkdir(targetPath, { recursive: true });
}

async function sha1ForFile(filePath: string): Promise<string> {
  const fileBuffer = await readFile(filePath);
  return createHash('sha1').update(fileBuffer).digest('hex');
}

async function sha256ForFile(filePath: string): Promise<string> {
  const fileBuffer = await readFile(filePath);
  return createHash('sha256').update(fileBuffer).digest('hex');
}

async function fileLooksValid(
  filePath: string,
  expectedSize?: number,
  expectedSha1?: string,
  expectedSha256?: string,
  minimumSize = 1,
): Promise<boolean> {
  try {
    const fileStat = await stat(filePath);
    if (expectedSize && fileStat.size !== expectedSize) {
      return false;
    }

    if (expectedSha1) {
      return (await sha1ForFile(filePath)) === expectedSha1;
    }

    if (expectedSha256) {
      return (await sha256ForFile(filePath)) === expectedSha256;
    }

    return fileStat.size >= minimumSize;
  } catch {
    return false;
  }
}

function resolveInside(basePath: string, childPath: string): string {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(resolvedBase, childPath);
  const relativePath = path.relative(resolvedBase, resolvedTarget);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Archive entry points outside destination: ${childPath}`);
  }

  return resolvedTarget;
}

async function withAbortTimeout<T>(
  label: string,
  work: (signal: AbortSignal, resetTimer: () => void) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  let rejectTimeout: ((error: Error) => void) | null = null;

  const resetTimer = () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }

    timeoutHandle = setTimeout(() => {
      controller.abort();
      rejectTimeout?.(new Error(`${label} timed out after ${Math.round(DOWNLOAD_IDLE_TIMEOUT_MS / 1000)} seconds`));
    }, DOWNLOAD_IDLE_TIMEOUT_MS);
  };

  resetTimer();
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const workPromise = work(controller.signal, resetTimer);

  try {
    return await Promise.race([workPromise, timeoutPromise]);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`${label} timed out after ${Math.round(DOWNLOAD_IDLE_TIMEOUT_MS / 1000)} seconds`);
    }
    throw error;
  } finally {
    void workPromise.catch(() => {});
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    rejectTimeout = null;
  }
}

async function writeStreamChunk(fileStream: WriteStream, chunk: Uint8Array): Promise<void> {
  if (fileStream.write(chunk)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let handleDrain = () => {};
    let handleError = (_error: Error) => {};
    const cleanup = () => {
      fileStream.removeListener('drain', handleDrain);
      fileStream.removeListener('error', handleError);
    };
    handleDrain = () => {
      cleanup();
      resolve();
    };
    handleError = (error: Error) => {
      cleanup();
      reject(error);
    };

    fileStream.once('drain', handleDrain);
    fileStream.once('error', handleError);
  });
}

async function closeWriteStream(fileStream: WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    fileStream.end((error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function candidateUrls(url: string): string[] {
  if (url.startsWith('https://piston-meta.mojang.com/')) {
    return [url, url.replace('https://piston-meta.mojang.com/', 'https://launchermeta.mojang.com/')];
  }

  if (url.startsWith('https://launchermeta.mojang.com/')) {
    return [url, url.replace('https://launchermeta.mojang.com/', 'https://piston-meta.mojang.com/')];
  }

  return [url];
}

async function fetchBuffer(url: string): Promise<Buffer> {
  return withAbortTimeout(`Request ${url}`, async (signal, resetTimer) => {
    const response = await fetch(url, {
      signal,
      headers: {
        'user-agent': USER_AGENT,
        accept: '*/*',
      },
    });

    resetTimer();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while requesting ${url}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    resetTimer();
    return Buffer.from(arrayBuffer);
  });
}

export async function fetchJson<T>(urls: readonly string[] | string[]): Promise<T> {
  const errors: string[] = [];

  for (const url of urls) {
    try {
      const buffer = await fetchBuffer(url);
      return JSON.parse(buffer.toString('utf8')) as T;
    } catch (error) {
      errors.push(`${url}: ${formatError(error)}`);
    }
  }

  throw new Error(`Unable to fetch JSON. ${errors.join(' | ')}`);
}

export async function downloadFile(job: DownloadJob, onProgress?: (downloadedBytes: number, totalBytes: number) => void): Promise<void> {
  const minimumSize = job.minimumSize ?? 1;
  if (await fileLooksValid(job.destination, job.expectedSize, job.expectedSha1, job.expectedSha256, minimumSize)) {
    onProgress?.(job.expectedSize ?? 0, job.expectedSize ?? 0);
    return;
  }

  await ensureDirectory(path.dirname(job.destination));

  const urls = [...new Set([...candidateUrls(job.url), ...(job.urls ?? [])])];
  const tempPath = `${job.destination}.tmp`;
  const errors: string[] = [];

  for (const url of urls) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      try {
        await withAbortTimeout(`Download ${url}`, async (signal, resetTimer) => {
          const response = await fetch(url, {
            signal,
            headers: {
              'user-agent': USER_AGENT,
              accept: '*/*',
            },
          });

          resetTimer();
          if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status} while downloading ${url}`);
          }

          const totalBytes = Number(response.headers.get('content-length') ?? job.expectedSize ?? 0);
          const fileStream = createWriteStream(tempPath);
          let downloadedBytes = 0;

          try {
            for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
              downloadedBytes += chunk.length;
              await writeStreamChunk(fileStream, chunk);
              onProgress?.(downloadedBytes, totalBytes);
              resetTimer();
            }

            await closeWriteStream(fileStream);
          } catch (error) {
            fileStream.destroy();
            throw error;
          }
        });

        if (!(await fileLooksValid(tempPath, job.expectedSize, job.expectedSha1, job.expectedSha256, minimumSize))) {
          throw new Error(`Checksum or size validation failed for ${url}`);
        }

        await rename(tempPath, job.destination);
        return;
      } catch (error) {
        errors.push(`${url} attempt ${attempt}: ${formatError(error)}`);
        await rm(tempPath, { force: true });
        await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
      }
    }
  }

  throw new Error(`Download failed for ${job.destination}. ${errors.join(' | ')}`);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = await readFile(filePath, 'utf8');
  return JSON.parse(content) as T;
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDirectory(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function nbtString(value: string): Buffer {
  const text = Buffer.from(value, 'utf8');
  const length = Buffer.allocUnsafe(2);
  length.writeUInt16BE(text.length, 0);
  return Buffer.concat([length, text]);
}

function nbtHeader(type: number, name: string): Buffer {
  return Buffer.concat([Buffer.from([type]), nbtString(name)]);
}

function nbtStringTag(name: string, value: string): Buffer {
  return Buffer.concat([nbtHeader(8, name), nbtString(value)]);
}

function nbtByteTag(name: string, value: number): Buffer {
  return Buffer.concat([nbtHeader(1, name), Buffer.from([value])]);
}

function createServersDat(serverName: string, serverAddress: string): Buffer {
  const serverEntry = Buffer.concat([
    nbtStringTag('name', serverName),
    nbtStringTag('ip', serverAddress),
    nbtByteTag('acceptTextures', 1),
    Buffer.from([0]),
  ]);

  const listLength = Buffer.allocUnsafe(4);
  listLength.writeInt32BE(1, 0);

  return Buffer.concat([
    nbtHeader(10, ''),
    nbtHeader(9, 'servers'),
    Buffer.from([10]),
    listLength,
    serverEntry,
    Buffer.from([0]),
  ]);
}

function bundledClientModsCandidates(): string[] {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return [
    path.join(__dirname, '..', 'dist', BUNDLED_CLIENT_MODS_DIR),
    path.join(process.cwd(), 'dist', BUNDLED_CLIENT_MODS_DIR),
    path.join(process.cwd(), 'public', BUNDLED_CLIENT_MODS_DIR),
    ...(resourcesPath ? [path.join(resourcesPath, BUNDLED_CLIENT_MODS_DIR)] : []),
  ];
}

async function findBundledClientModsDir(): Promise<string | null> {
  const seen = new Set<string>();

  for (const candidate of bundledClientModsCandidates()) {
    if (seen.has(candidate)) {
      continue;
    }

    seen.add(candidate);
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function readBundledVersionFile(): Promise<VersionFile | null> {
  const bundledDir = await findBundledClientModsDir();
  if (!bundledDir) {
    return null;
  }

  const manifestPath = path.join(bundledDir, `${DEFAULT_RELEASE_VERSION}.json`);
  if (!(await pathExists(manifestPath))) {
    return null;
  }

  return readJsonFile<VersionFile>(manifestPath);
}

async function readManagedModFiles(metaPath: string): Promise<string[]> {
  if (!(await pathExists(metaPath))) {
    return [];
  }

  let meta: BundledModpackMeta;
  try {
    meta = await readJsonFile<BundledModpackMeta>(metaPath);
  } catch {
    return [];
  }

  if (!meta || !Array.isArray(meta.mods)) {
    return [];
  }

  return normalizeModpackMods(meta).map((mod) => mod.file);
}

async function readBundledModpack(sourceModsDir: string): Promise<{ meta: BundledModpackMeta; mods: ResolvedClientMod[] }> {
  const metaPath = path.join(sourceModsDir, BUNDLED_MODPACK_META_FILE);
  const meta = (await pathExists(metaPath)) ? await readJsonFile<BundledModpackMeta>(metaPath).catch(() => ({})) : {};
  const managedMods = normalizeModpackMods(meta);

  if (managedMods.length > 0) {
    return { meta, mods: managedMods };
  }

  const entries = await readdir(sourceModsDir, { withFileTypes: true }).catch(() => []);
  const mods = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .map((fileName) => normalizeManagedModFileName(fileName))
    .filter((fileName): fileName is string => Boolean(fileName))
    .filter((fileName) => fileName.toLowerCase().endsWith('.jar'))
    .map((file) => ({ file }));

  return { meta, mods };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function remoteClientModpackManifestUrls(): string[] {
  return REMOTE_CLIENT_MODS_BASE_URLS.map((baseUrl) => `${trimTrailingSlash(baseUrl)}/mods/${BUNDLED_MODPACK_META_FILE}`);
}

function remoteClientModUrls(fileName: string): string[] {
  const encodedFileName = encodeURIComponent(fileName);
  return REMOTE_CLIENT_MODS_BASE_URLS.map((baseUrl) => `${trimTrailingSlash(baseUrl)}/mods/${encodedFileName}`);
}

function metaForInstalledClientMods(meta: BundledModpackMeta, mods: ResolvedClientMod[], source: 'remote' | 'bundled'): BundledModpackMeta {
  return {
    ...meta,
    source,
    syncedAt: new Date().toISOString(),
    mods,
  };
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      await worker(items[index], index);
    }
  });

  await Promise.all(runners);
}

function runtimeApiOs(): string {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'mac';
    default:
      return 'linux';
  }
}

function runtimeApiArch(): string {
  switch (process.arch) {
    case 'arm64':
      return 'aarch64';
    case 'ia32':
      return 'x86-32';
    default:
      return 'x64';
  }
}

async function findJavaExecutable(rootDir: string): Promise<string | null> {
  if (!(await pathExists(rootDir))) {
    return null;
  }

  const queue = [rootDir];
  const targetName = process.platform === 'win32' ? 'javaw.exe' : 'java';
  let scannedDirectories = 0;

  while (queue.length > 0 && scannedDirectories < 3000) {
    const currentDir = queue.shift() as string;
    scannedDirectories += 1;
    const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name.toLowerCase() === targetName) {
        return entryPath;
      }
    }
  }

  return null;
}

async function extractZip(archivePath: string, destination: string): Promise<void> {
  const archiveBuffer = await readFile(archivePath);
  const entries = unzipSync(new Uint8Array(archiveBuffer));
  await ensureDirectory(destination);

  for (const [entryName, data] of Object.entries(entries)) {
    const normalized = entryName.replace(/\\/g, '/');
    if (normalized.endsWith('/')) {
      await ensureDirectory(resolveInside(destination, normalized));
      continue;
    }

    const targetPath = resolveInside(destination, normalized);
    await ensureDirectory(path.dirname(targetPath));
    await writeFile(targetPath, Buffer.from(data));
  }
}

async function extractTarGz(archivePath: string, destination: string): Promise<void> {
  await ensureDirectory(destination);
  await tar.x({
    file: archivePath,
    cwd: destination,
    preservePaths: false,
    filter: (entryPath) => {
      resolveInside(destination, entryPath);
      return true;
    },
  });
}

async function locateSystemJavaBinary(): Promise<string | null> {
  const command = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(command, ['java'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  if (result.error || result.status !== 0) {
    return null;
  }

  const firstLine = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine || !(await fileIsRegularFile(firstLine))) {
    return null;
  }

  return firstLine;
}

function javaSourceLabel(source: JavaSource): string {
  switch (source) {
    case 'bundled':
      return 'встроенная Java';
    case 'custom':
      return 'указанная Java';
    case 'system':
      return 'системная Java';
    default:
      return 'Java';
  }
}

function looksLikeJavaExecutable(javaPath: string): boolean {
  const executableName = path.basename(javaPath).toLowerCase();
  return executableName === 'java' || executableName === 'java.exe' || executableName === 'javaw.exe';
}

function parseJavaMajorVersion(output: string): number | null {
  const versionMatch = output.match(/version\s+"([^"]+)"/i);
  const versionText = versionMatch?.[1] ?? output;
  const parts = versionText.match(/\d+/g)?.map(Number) ?? [];

  if (parts.length === 0) {
    return null;
  }

  if (parts[0] === 1 && parts.length > 1) {
    return parts[1];
  }

  return parts[0];
}

async function javaVersionProbePath(javaPath: string): Promise<string> {
  if (path.basename(javaPath).toLowerCase() !== 'javaw.exe') {
    return javaPath;
  }

  const consoleJavaPath = path.join(path.dirname(javaPath), 'java.exe');
  return (await fileIsRegularFile(consoleJavaPath)) ? consoleJavaPath : javaPath;
}

async function detectJavaMajorVersion(javaPath: string): Promise<number | null> {
  const probePath = await javaVersionProbePath(javaPath);
  const result = spawnSync(probePath, ['-version'], {
    encoding: 'utf8',
    timeout: 5000,
    windowsHide: true,
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  return parseJavaMajorVersion(`${result.stdout}\n${result.stderr}`);
}

async function validateJavaExecutable(javaPath: string, requiredMajor: number, source: JavaSource): Promise<void> {
  if (!(await fileIsRegularFile(javaPath))) {
    throw new Error(`${javaSourceLabel(source)} не найдена: ${javaPath}`);
  }

  if (!looksLikeJavaExecutable(javaPath)) {
    throw new Error(`Укажите путь именно к java.exe, а не к другому файлу: ${javaPath}`);
  }

  const majorVersion = await detectJavaMajorVersion(javaPath);
  if (!majorVersion) {
    throw new Error(`Не удалось определить версию Java: ${javaPath}`);
  }

  if (majorVersion < requiredMajor) {
    throw new Error(`Для FlexCraft нужна Java ${requiredMajor} или новее. Сейчас выбрана Java ${majorVersion}: ${javaPath}`);
  }
}

export class LauncherService {
  private readonly paths: LauncherPaths;
  private readonly launcherName: string;
  private readonly launcherVersion: string;
  private readonly startupWarning: string | null;
  private readonly emitSnapshot: (snapshot: LauncherSnapshot) => void;

  private config: LauncherConfig = defaultConfig();
  private status: LauncherStatus;
  private session: AuthSession | null = null;
  private launcherAuth: StoredLauncherAuth | null = null;
  private versionIndex: VersionManifestIndex | null = null;
  private activeTask: Promise<void> | null = null;
  private launchProcess: ChildProcessWithoutNullStreams | null = null;

  constructor(options: {
    userDataDir: string;
    launcherName: string;
    launcherVersion: string;
    startupWarning?: string;
    emitSnapshot: (snapshot: LauncherSnapshot) => void;
  }) {
    this.launcherName = options.launcherName;
    this.launcherVersion = options.launcherVersion;
    this.startupWarning = options.startupWarning?.trim() || null;
    this.emitSnapshot = options.emitSnapshot;

    const rootDir = options.userDataDir;
    this.paths = {
      rootDir,
      configPath: path.join(rootDir, 'launcher-config.json'),
      authPath: path.join(rootDir, 'launcher-auth.json'),
      legacyAccountsPath: path.join(rootDir, 'accounts.json'),
      cacheDir: path.join(rootDir, 'cache'),
      manifestsDir: path.join(rootDir, 'cache', 'manifests'),
      downloadsDir: path.join(rootDir, 'cache', 'downloads'),
      runtimeDir: path.join(rootDir, 'runtime'),
      gameDir: path.join(rootDir, 'game'),
      versionsDir: path.join(rootDir, 'game', 'versions'),
      librariesDir: path.join(rootDir, 'game', 'libraries'),
      assetsDir: path.join(rootDir, 'game', 'assets'),
      nativesDir: path.join(rootDir, 'game', 'natives'),
      logsDir: path.join(rootDir, 'logs'),
      launcherLogPath: path.join(rootDir, 'logs', 'launcher.log'),
    };

    this.status = {
      versionId: DEFAULT_RELEASE_VERSION,
      latestRelease: DEFAULT_RELEASE_VERSION,
      gameDir: this.paths.gameDir,
      installed: false,
      javaReady: false,
      javaSource: 'missing',
      javaPath: '',
      isBusy: false,
      isLaunching: false,
      statusLine: 'Войдите в профиль, чтобы начать.',
      progress: null,
      warning: null,
      lastError: null,
      dataRoot: this.paths.rootDir,
      logsDir: this.paths.logsDir,
      logs: [],
    };
  }

  async initialize(): Promise<void> {
    await ensureDirectory(this.paths.rootDir);
    await ensureDirectory(this.paths.logsDir);
    await ensureDirectory(this.paths.cacheDir);

    if (await pathExists(this.paths.configPath)) {
      this.config = sanitizeConfig(
        await this.readStartupJsonOrRestore<LauncherConfig>(this.paths.configPath, defaultConfig(), 'настройки лаунчера'),
      );
    } else {
      this.config = defaultConfig();
      await writeJsonFile(this.paths.configPath, this.config);
    }

    const authPath = (await pathExists(this.paths.authPath)) ? this.paths.authPath : this.paths.legacyAccountsPath;
    if (await pathExists(authPath)) {
      const stored = await this.readStartupJsonOrRestore<LauncherAccountFile>(
        authPath,
        { launcherAuth: null },
        'аккаунт лаунчера',
      );
      this.launcherAuth = sanitizeStoredLauncherAuth(stored.launcherAuth);
      this.session = sanitizeStoredSession(this.launcherAuth);
      if (authPath === this.paths.legacyAccountsPath) {
        await this.persistLauncherAuth();
      }
    } else {
      await this.persistLauncherAuth();
    }

    await this.refreshLauncherAuthSession();
    this.syncConfigUsernameFromSession();
    await this.runStartupStep('Список серверов', () => this.syncServerList());
    await this.runStartupStep('Клиентские моды', () => this.syncClientMods());
    this.status.versionId = this.config.preferredVersion;
    await this.runStartupStep('Статус лаунчера', () => this.refreshStatus());
  }

  getSnapshot(): LauncherSnapshot {
    return {
      config: { ...this.config },
      status: {
        ...this.status,
        logs: [...this.status.logs],
        progress: this.status.progress ? { ...this.status.progress } : null,
      },
      session: this.session ? { ...this.session } : null,
    };
  }

  async saveConfig(partial: Partial<LauncherConfig>): Promise<LauncherSnapshot> {
    this.config = sanitizeConfig({ ...this.config, ...partial });
    this.syncConfigUsernameFromSession();
    this.status.versionId = this.config.preferredVersion;
    await writeJsonFile(this.paths.configPath, this.config);
    await this.syncServerList();
    await this.refreshStatus();
    return this.getSnapshot();
  }

  async logoutAccount(): Promise<LauncherSnapshot> {
    if (this.session) {
      this.pushLog(`Выход из профиля: ${this.session.login}.`);
    }

    if (this.launcherAuth?.token) {
      await fetchApi('/launcher/session/logout', { method: 'POST', token: this.launcherAuth.token }).catch(() => {});
    }

    this.session = null;
    this.launcherAuth = null;
    await this.persistLauncherAuth();
    await this.refreshStatus();
    return this.getSnapshot();
  }

  async startLauncherAccountLink(): Promise<LauncherDeviceStart> {
    const response = await fetchApi<ApiEnvelope<LauncherDeviceStart>>('/launcher/device/start', { method: 'POST' });
    if (!response.deviceCode || !response.verificationUri) {
      throw new Error('Сервер авторизации не вернул ссылку входа.');
    }

    return {
      deviceCode: response.deviceCode,
      verificationUri: response.verificationUri,
      verificationUriComplete: response.verificationUriComplete,
      expiresIn: Number(response.expiresIn || 600),
      interval: Number(response.interval || 3),
    };
  }

  async completeLauncherAccountLink(deviceCode: string): Promise<LauncherSnapshot> {
    const response = await fetchApi<ApiEnvelope<LauncherDevicePoll>>('/launcher/device/poll', {
      method: 'POST',
      body: { deviceCode },
    });

    if (response.status === 'pending') {
      throw new Error('pending');
    }
    if (response.status !== 'approved' || !response.token || !response.user) {
      throw new Error(response.error || 'Не удалось подключить аккаунт FlexCraft.');
    }

    const user = sanitizeFlexCraftUser(response.user);
    if (!user) {
      throw new Error('Сервер вернул некорректный профиль.');
    }

    this.launcherAuth = {
      token: response.token,
      user,
      createdAt: new Date().toISOString(),
    };
    this.session = flexUserToSession(user);
    this.syncConfigUsernameFromSession();
    await this.persistLauncherAuth();
    await writeJsonFile(this.paths.configPath, this.config);
    await this.refreshStatus();
    this.pushLog(`Подключён аккаунт FlexCraft: ${user.login}.`);
    return this.getSnapshot();
  }

  async openGameFolder(): Promise<void> {
    await ensureDirectory(this.paths.gameDir);
  }

  async openDataFolder(): Promise<void> {
    await ensureDirectory(this.paths.rootDir);
  }

  async openLogsFolder(): Promise<void> {
    await ensureDirectory(this.paths.logsDir);
  }

  async installLatestVanilla(): Promise<void> {
    await this.runTask('Подготавливаем клиент FlexCraft...', async () => {
      const versionId = await this.resolveLatestRelease();
      this.config.preferredVersion = versionId;
      this.status.versionId = versionId;
      await writeJsonFile(this.paths.configPath, this.config);
      await this.syncServerList();
      await this.syncMinecraftOptions();
      await this.ensureInstallation(versionId);
      await this.refreshStatus();
      this.pushLog(`Клиент FlexCraft ${versionId} готов.`);
      this.status.statusLine = `Клиент FlexCraft ${versionId} готов к запуску.`;
    });
  }

  async launchLatestVanilla(): Promise<void> {
    if (!this.session) {
      throw new Error('Войдите в профиль перед запуском.');
    }

    await this.runTask('Запускаем клиент FlexCraft...', async () => {
      const versionId = await this.resolveLatestRelease();
      this.config.preferredVersion = versionId;
      this.status.versionId = versionId;
      await writeJsonFile(this.paths.configPath, this.config);
      await this.syncServerList();
      await this.syncMinecraftOptions();
      const installState = await this.ensureInstallation(versionId);
      await this.launchClient(installState);
      await this.refreshStatus();
    });
  }

  private async refreshStatus(): Promise<void> {
    const versionId = this.config.preferredVersion || DEFAULT_RELEASE_VERSION;
    const versionDir = path.join(this.paths.versionsDir, versionId);
    const versionJsonPath = path.join(versionDir, `${versionId}.json`);
    const versionJarPath = path.join(versionDir, `${versionId}.jar`);

    const installed = (await pathExists(versionJsonPath)) && (await pathExists(versionJarPath));
    const java = await this.resolveJavaExecutable(false);

    this.status.installed = installed;
    this.status.javaReady = Boolean(java?.javaPath);
    this.status.javaSource = java?.javaSource ?? 'missing';
    this.status.javaPath = java?.javaPath ?? '';
    this.status.warning = this.buildWarning();
    this.emitSnapshot(this.getSnapshot());
  }

  private async syncServerList(): Promise<void> {
    const serverAddress = this.config.serverAddress.trim();

    if (!serverAddress) {
      return;
    }

    await ensureDirectory(this.paths.gameDir);
    await writeFile(path.join(this.paths.gameDir, 'servers.dat'), createServersDat(DEFAULT_SERVER_NAME, serverAddress));
  }

  private async syncMinecraftOptions(): Promise<void> {
    const optionsPath = path.join(this.paths.gameDir, 'options.txt');
    const options = (await pathExists(optionsPath))
      ? parseMinecraftOptions(await readFile(optionsPath, 'utf8').catch(() => ''))
      : new Map<string, string>();

    for (const [key, value] of Object.entries(DEFAULT_MINECRAFT_OPTIONS)) {
      options.set(key, value);
    }

    for (const [key, value] of Object.entries(DEFAULT_MINECRAFT_KEY_OPTIONS)) {
      if (!options.has(key)) {
        options.set(key, value);
      }
    }

    await ensureDirectory(this.paths.gameDir);
    await writeFile(optionsPath, serializeMinecraftOptions(options), 'utf8');
  }

  private async syncClientMods(): Promise<void> {
    try {
      await this.syncRemoteClientMods();
      return;
    } catch (error) {
      this.pushLog(`Не удалось обновить клиентские моды с сайта: ${formatError(error)}`);
    }

    await this.syncBundledMods();
  }

  private async syncRemoteClientMods(): Promise<void> {
    const meta = await fetchJson<BundledModpackMeta>(remoteClientModpackManifestUrls());
    const mods = normalizeModpackMods(meta);

    if (mods.length === 0) {
      throw new Error('Remote modpack manifest does not contain valid mods.');
    }

    const destinationModsDir = path.join(this.paths.gameDir, 'mods');
    const destinationMetaPath = path.join(destinationModsDir, BUNDLED_MODPACK_META_FILE);
    const previousManagedFiles = await readManagedModFiles(destinationMetaPath);
    const managedFiles = new Set(mods.map((mod) => mod.file));

    await ensureDirectory(destinationModsDir);

    for (const fileName of previousManagedFiles) {
      if (!managedFiles.has(fileName)) {
        await rm(path.join(destinationModsDir, fileName), { force: true });
      }
    }

    let synced = 0;
    await runWithConcurrency(mods, 3, async (mod) => {
      const urls = remoteClientModUrls(mod.file);
      await downloadFile(
        {
          url: urls[0],
          urls: urls.slice(1),
          destination: path.join(destinationModsDir, mod.file),
          expectedSha1: mod.sha1,
          expectedSha256: mod.sha256,
          expectedSize: mod.size,
          minimumSize: 1024,
        },
        (downloadedBytes, totalBytes) => {
          if (totalBytes > 0) {
            this.updateProgress('client-mod', downloadedBytes, totalBytes, `Скачиваем мод ${mod.file}...`);
          }
        },
      );

      synced += 1;
      this.updateProgress('client-mods', synced, mods.length, `Синхронизируем моды FlexCraft ${synced}/${mods.length}`);
    });

    await writeJsonFile(destinationMetaPath, metaForInstalledClientMods(meta, mods, 'remote'));
    this.pushLog(`Моды FlexCraft обновлены с сайта: ${mods.length}.`);
  }

  private async syncBundledMods(): Promise<void> {
    const bundledDir = await findBundledClientModsDir();
    if (!bundledDir) {
      this.pushLog('В этой сборке не найдены клиентские моды.');
      return;
    }

    const sourceModsDir = path.join(bundledDir, 'mods');
    if (!(await pathExists(sourceModsDir))) {
      this.pushLog('Папка клиентских модов отсутствует.');
      return;
    }

    const destinationModsDir = path.join(this.paths.gameDir, 'mods');
    const destinationMetaPath = path.join(destinationModsDir, BUNDLED_MODPACK_META_FILE);
    const previousManagedFiles = await readManagedModFiles(destinationMetaPath);
    const { meta, mods } = await readBundledModpack(sourceModsDir);
    const managedFiles = new Set(mods.map((mod) => mod.file));

    if (mods.length === 0) {
      this.pushLog('Встроенный модпак FlexCraft пуст.');
      return;
    }

    await ensureDirectory(destinationModsDir);

    for (const fileName of previousManagedFiles) {
      if (!managedFiles.has(fileName)) {
        await rm(path.join(destinationModsDir, fileName), { force: true });
      }
    }

    let copied = 0;
    for (const mod of mods) {
      const sourcePath = path.join(sourceModsDir, mod.file);
      const destinationPath = path.join(destinationModsDir, mod.file);

      if (!(await pathExists(sourcePath))) {
        continue;
      }

      await writeFile(destinationPath, await readFile(sourcePath));
      copied += 1;
    }

    await writeJsonFile(destinationMetaPath, metaForInstalledClientMods(meta, mods, 'bundled'));
    this.pushLog(`Синхронизировано модов FlexCraft: ${copied}.`);
  }

  private buildWarning(): string | null {
    if (this.startupWarning) {
      return this.startupWarning;
    }

    if (!this.session) {
      return 'Сначала войдите в профиль.';
    }

    if (this.config.serverAddress.trim()) {
      return 'Профиль готов. Если сервер потребует лицензионный вход, подключение может быть отклонено настройками сервера.';
    }

    return 'Укажите адрес сервера перед запуском.';
  }

  private syncConfigUsernameFromSession(): void {
    if (!this.session) {
      return;
    }

    this.config.username = sanitizeUsername(this.session.username);
  }

  private async readStartupJsonOrRestore<T>(filePath: string, fallback: T, label: string): Promise<T> {
    try {
      return await readJsonFile<T>(filePath);
    } catch (error) {
      const backupPath = `${filePath}.broken-${Date.now()}`;
      const message = formatError(error);

      try {
        await rename(filePath, backupPath);
        this.pushLog(`Поврежденный файл (${label}) сохранен как ${path.basename(backupPath)}: ${message}`);
      } catch {
        await rm(filePath, { force: true });
        this.pushLog(`Поврежденный файл (${label}) удален: ${message}`);
      }

      await writeJsonFile(filePath, fallback);
      return fallback;
    }
  }

  private async runStartupStep(label: string, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (error) {
      const message = `${label}: ${formatError(error)}`;
      this.status.lastError = message;
      this.status.statusLine = 'Лаунчер открыт, но часть подготовки не выполнена.';
      this.pushLog(`Ошибка запуска: ${message}`);
    }
  }

  private async persistLauncherAuth(): Promise<void> {
    await writeJsonFile(this.paths.authPath, {
      launcherAuth: this.launcherAuth,
    });
  }

  private async refreshLauncherAuthSession(): Promise<void> {
    if (!this.launcherAuth?.token) {
      return;
    }

    try {
      const response = await fetchApi<ApiEnvelope<FlexCraftUser>>('/launcher/session/me', {
        method: 'POST',
        token: this.launcherAuth.token,
      });
      const user = sanitizeFlexCraftUser(response.user);
      if (!user) {
        throw new Error('Сервер вернул некорректный профиль.');
      }

      this.launcherAuth = {
        ...this.launcherAuth,
        user,
      };
      this.session = flexUserToSession(user);
      await this.persistLauncherAuth();
    } catch (error) {
      this.pushLog(`Сессия FlexCraft недоступна: ${formatError(error)}`);
      this.launcherAuth = null;
      if (this.session?.source === 'flexcraft') {
        this.session = null;
      }
      await this.persistLauncherAuth();
    }
  }

  private async runTask(title: string, work: () => Promise<void>): Promise<void> {
    if (this.activeTask) {
      await this.activeTask;
      return;
    }

    this.status.isBusy = true;
    this.status.lastError = null;
    this.status.statusLine = title;
    this.status.progress = null;
    this.emitSnapshot(this.getSnapshot());

    const task = work()
      .catch(async (error) => {
        const message = formatError(error);
        this.status.lastError = message;
        this.status.statusLine = message;
        this.pushLog(`Ошибка: ${message}`);
        throw error;
      })
      .finally(() => {
        this.status.isBusy = false;
        this.status.progress = null;
        this.activeTask = null;
        this.emitSnapshot(this.getSnapshot());
      });

    this.activeTask = task;
    await task;
  }

  private updateProgress(stage: string, current: number, total: number, detail: string): void {
    const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
    this.status.progress = { stage, current, total, percent, detail };
    this.status.statusLine = detail;
    this.emitSnapshot(this.getSnapshot());
  }

  private pushLog(line: string): void {
    const timestamp = new Date().toISOString();
    const formatted = `[${timestamp}] ${line}`;
    this.status.logs = [...this.status.logs, formatted].slice(-LOG_RETENTION);
    void appendFile(this.paths.launcherLogPath, `${formatted}\n`, 'utf8').catch(() => {});
    this.emitSnapshot(this.getSnapshot());
  }

  private async resolveLatestRelease(): Promise<string> {
    this.status.latestRelease = DEFAULT_RELEASE_VERSION;
    return DEFAULT_RELEASE_VERSION;
  }

  private async loadVersionIndex(): Promise<VersionManifestIndex> {
    try {
      if (!this.versionIndex) {
        this.versionIndex = await fetchJson<VersionManifestIndex>(VERSION_MANIFEST_URLS);
        await writeJsonFile(path.join(this.paths.manifestsDir, 'version_manifest_v2.json'), this.versionIndex);
      }

      return this.versionIndex;
    } catch (error) {
      this.pushLog(`Используем сохраненный манифест версий: ${formatError(error)}`);
      const cachedPath = path.join(this.paths.manifestsDir, 'version_manifest_v2.json');
      if (await pathExists(cachedPath)) {
        this.versionIndex = await readJsonFile<VersionManifestIndex>(cachedPath);
        return this.versionIndex;
      }

      throw error;
    }
  }

  private async resolveVersionFile(versionId: string): Promise<VersionFile> {
    const manifestDir = path.join(this.paths.manifestsDir, versionId);
    const manifestPath = path.join(manifestDir, `${versionId}.json`);

    if (versionId === DEFAULT_RELEASE_VERSION) {
      const bundledVersion = await readBundledVersionFile();
      if (bundledVersion) {
        await writeJsonFile(manifestPath, bundledVersion);
        return bundledVersion;
      }
    }

    if (await pathExists(manifestPath)) {
      return readJsonFile<VersionFile>(manifestPath);
    }

    const versionIndex = await this.loadVersionIndex();

    const versionMetadata = versionIndex.versions.find((entry) => entry.id === versionId);
    if (!versionMetadata) {
      throw new Error(`Версия ${versionId} не найдена в манифесте Mojang.`);
    }

    const versionFile = await fetchJson<VersionFile>(candidateUrls(versionMetadata.url));
    await writeJsonFile(manifestPath, versionFile);
    return versionFile;
  }

  private async resolveRuntimePackage(): Promise<RuntimePackageDescriptor> {
    const url = `https://api.adoptium.net/v3/assets/latest/25/hotspot?architecture=${runtimeApiArch()}&heap_size=normal&image_type=jre&os=${runtimeApiOs()}&vendor=eclipse`;
    const packages = await fetchJson<RuntimeApiAsset[]>([url]);
    const descriptor = packages[0]?.binary?.package ?? packages[0]?.package;

    if (!descriptor) {
      throw new Error('Не удалось подобрать Java 25 для этой системы.');
    }

    return descriptor;
  }

  private async ensureBundledJava(): Promise<string> {
    const descriptor = await this.resolveRuntimePackage();
    const installRoot = path.join(this.paths.runtimeDir, `${process.platform}-${process.arch}-temurin-25`);
    const markerPath = path.join(installRoot, '.runtime.json');

    if (await pathExists(markerPath)) {
      try {
        const installedMeta = await readJsonFile<{ checksum: string; javaPath: string }>(markerPath);
        if ((await pathExists(installedMeta.javaPath)) && installedMeta.checksum === descriptor.checksum) {
          return installedMeta.javaPath;
        }
      } catch (error) {
        this.pushLog(`Кэш Java поврежден, переустанавливаем runtime: ${formatError(error)}`);
        await rm(markerPath, { force: true });
      }
    }

    await ensureDirectory(this.paths.runtimeDir);
    const archiveName = path.basename(descriptor.name);
    if (!archiveName || archiveName === '.' || archiveName === '..') {
      throw new Error(`Некорректное имя архива Java: ${descriptor.name}`);
    }

    const archivePath = path.join(this.paths.downloadsDir, archiveName);
    this.pushLog(`Скачиваем Java: ${archiveName}`);
    await downloadFile(
      {
        url: descriptor.link,
        destination: archivePath,
        expectedSha256: descriptor.checksum,
        expectedSize: descriptor.size,
      },
      (downloadedBytes, totalBytes) => {
        this.updateProgress('java', downloadedBytes, totalBytes || descriptor.size, 'Скачиваем Java...');
      },
    );

    const extractRoot = path.join(this.paths.runtimeDir, `${path.basename(archiveName, path.extname(archiveName))}-extract`);
    await rm(extractRoot, { recursive: true, force: true });
    await rm(installRoot, { recursive: true, force: true });

    if (archiveName.endsWith('.zip')) {
      await extractZip(archivePath, extractRoot);
    } else {
      await extractTarGz(archivePath, extractRoot);
    }

    const javaPath = await findJavaExecutable(extractRoot);
    if (!javaPath) {
      throw new Error('Java распакована, но исполняемый файл не найден.');
    }

    await rename(extractRoot, installRoot);
    const finalJavaPath = await findJavaExecutable(installRoot);
    if (!finalJavaPath) {
      throw new Error('Java установлена, но путь к запуску не найден.');
    }

    await writeJsonFile(markerPath, { checksum: descriptor.checksum, javaPath: finalJavaPath });
    return finalJavaPath;
  }

  private async resolveJavaExecutable(
    allowDownload: boolean,
    requiredMajor = REQUIRED_JAVA_MAJOR_VERSION,
  ): Promise<{ javaPath: string; javaSource: JavaSource } | null> {
    if (!this.config.useBundledJava && this.config.javaExecutable) {
      try {
        await validateJavaExecutable(this.config.javaExecutable, requiredMajor, 'custom');
        return { javaPath: this.config.javaExecutable, javaSource: 'custom' };
      } catch (error) {
        if (allowDownload) {
          throw error;
        }
        this.pushLog(`Указанная Java недоступна: ${formatError(error)}`);
        return null;
      }
    }

    if (this.config.useBundledJava) {
      try {
        if (allowDownload) {
          const javaPath = await this.ensureBundledJava();
          await validateJavaExecutable(javaPath, requiredMajor, 'bundled');
          return { javaPath, javaSource: 'bundled' };
        }

        const cachedJava = await findJavaExecutable(this.paths.runtimeDir);
        if (cachedJava) {
          await validateJavaExecutable(cachedJava, requiredMajor, 'bundled');
          return { javaPath: cachedJava, javaSource: 'bundled' };
        }
      } catch (error) {
        this.pushLog(`Встроенная Java пока недоступна: ${formatError(error)}`);
      }
    }

    const systemJava = await locateSystemJavaBinary();
    if (systemJava) {
      try {
        await validateJavaExecutable(systemJava, requiredMajor, 'system');
        return { javaPath: systemJava, javaSource: 'system' };
      } catch (error) {
        this.pushLog(`Системная Java не подходит: ${formatError(error)}`);
      }
    }

    return null;
  }

  private async ensureInstallation(versionId: string): Promise<LaunchContext> {
    const versionFile = await this.resolveVersionFile(versionId);
    const requiredJavaMajor = versionFile.javaVersion?.majorVersion ?? REQUIRED_JAVA_MAJOR_VERSION;
    const java = await this.resolveJavaExecutable(true, requiredJavaMajor);
    if (!java) {
      throw new Error(`Java ${requiredJavaMajor} не найдена. Включите встроенную Java или укажите свой путь к java.exe.`);
    }

    const versionDir = path.join(this.paths.versionsDir, versionId);
    const versionJsonPath = path.join(versionDir, `${versionId}.json`);
    const versionJarPath = path.join(versionDir, `${versionId}.jar`);
    const assetIndexPath = path.join(this.paths.assetsDir, 'indexes', `${versionFile.assetIndex.id}.json`);

    await ensureDirectory(versionDir);
    await ensureDirectory(this.paths.librariesDir);
    await ensureDirectory(path.join(this.paths.assetsDir, 'indexes'));
    await ensureDirectory(path.join(this.paths.assetsDir, 'objects'));
    await ensureDirectory(path.join(this.paths.assetsDir, 'log_configs'));
    await ensureDirectory(this.paths.nativesDir);

    await writeJsonFile(versionJsonPath, versionFile);
    await downloadFile(
      {
        url: versionFile.downloads.client.url,
        destination: versionJarPath,
        expectedSha1: versionFile.downloads.client.sha1,
        expectedSize: versionFile.downloads.client.size,
      },
      (downloadedBytes, totalBytes) => {
        this.updateProgress(
          'client',
          downloadedBytes,
          totalBytes || versionFile.downloads.client.size || 0,
          'Скачиваем клиент Minecraft...',
        );
      },
    );

    if (versionFile.logging?.client) {
      const loggingFilePath = path.join(this.paths.assetsDir, 'log_configs', versionFile.logging.client.file.id);
      await downloadFile(
        {
          url: versionFile.logging.client.file.url,
          destination: loggingFilePath,
          expectedSha1: versionFile.logging.client.file.sha1,
          expectedSize: versionFile.logging.client.file.size,
        },
        (downloadedBytes, totalBytes) => {
          this.updateProgress('logging', downloadedBytes, totalBytes || versionFile.logging?.client?.file.size || 0, 'Скачиваем настройки логов...');
        },
      );
    }

    await downloadFile(
      {
        url: versionFile.assetIndex.url,
        destination: assetIndexPath,
        expectedSha1: versionFile.assetIndex.sha1,
        expectedSize: versionFile.assetIndex.size,
      },
      (downloadedBytes, totalBytes) => {
        this.updateProgress('asset-index', downloadedBytes, totalBytes || versionFile.assetIndex.size, 'Скачиваем список ресурсов...');
      },
    );

    const assetIndex = await readJsonFile<AssetIndexFile>(assetIndexPath);
    const libraryArtifacts = this.collectLibraryArtifacts(versionFile);
    const nativeArtifacts = this.collectNativeArtifacts(versionFile);

    let completedLibraries = 0;
    await runWithConcurrency(libraryArtifacts, 6, async (artifact) => {
      await downloadFile({
        url: artifact.url,
        destination: path.join(this.paths.librariesDir, artifact.path),
        expectedSha1: artifact.sha1,
        expectedSize: artifact.size,
        minimumSize: MIN_LIBRARY_ARTIFACT_BYTES,
      });
      completedLibraries += 1;
      this.updateProgress('libraries', completedLibraries, libraryArtifacts.length, `Скачиваем библиотеки ${completedLibraries}/${libraryArtifacts.length}`);
    });

    const assetObjects = Object.values(assetIndex.objects);
    let completedAssets = 0;
    await runWithConcurrency(assetObjects, 12, async (asset) => {
      const objectPath = path.join(this.paths.assetsDir, 'objects', asset.hash.slice(0, 2), asset.hash);
      await downloadFile({
        url: `https://resources.download.minecraft.net/${asset.hash.slice(0, 2)}/${asset.hash}`,
        destination: objectPath,
        expectedSha1: asset.hash,
        expectedSize: asset.size,
      });
      completedAssets += 1;
      this.updateProgress('assets', completedAssets, assetObjects.length, `Скачиваем ресурсы ${completedAssets}/${assetObjects.length}`);
    });

    await this.extractNativeLibraries(versionId, versionFile, nativeArtifacts);
    await this.syncClientMods();

    this.status.installed = true;
    this.status.javaReady = true;
    this.status.javaSource = java.javaSource;
    this.status.javaPath = java.javaPath;
    this.status.warning = this.buildWarning();

    return {
      version: versionFile,
      javaPath: java.javaPath,
      javaSource: java.javaSource,
    };
  }

  private collectLibraryArtifacts(versionFile: VersionFile): LibraryArtifact[] {
    return versionFile.libraries
      .filter((library) => isAllowedByRules(library.rules))
      .map((library) => library.downloads?.artifact)
      .filter((artifact): artifact is LibraryArtifact => Boolean(artifact))
      .filter((artifact) => !artifact.path.includes('natives-'));
  }

  private collectNativeArtifacts(versionFile: VersionFile): Array<LibraryArtifact & { exclude?: string[] }> {
    const artifacts: Array<LibraryArtifact & { exclude?: string[] }> = [];
    const seenPaths = new Set<string>();

    for (const library of versionFile.libraries) {
      if (!isAllowedByRules(library.rules)) {
        continue;
      }

      const addArtifact = (artifact: LibraryArtifact | undefined) => {
        if (!artifact || !nativeArtifactMatchesCurrentArch(artifact.path) || seenPaths.has(artifact.path)) {
          return;
        }

        seenPaths.add(artifact.path);
        artifacts.push({ ...artifact, exclude: library.extract?.exclude });
      };

      addArtifact(library.downloads?.artifact);

      const nativeClassifier = library.natives?.[minecraftOsName()];
      if (nativeClassifier && library.downloads?.classifiers) {
        const classifierArch = process.arch === 'ia32' ? '32' : process.arch === 'x64' ? '64' : process.arch;
        addArtifact(library.downloads.classifiers[nativeClassifier.replace('${arch}', classifierArch)]);
      }

      for (const [classifierName, classifier] of Object.entries(library.downloads?.classifiers ?? {})) {
        if (classifierName.includes('natives')) {
          addArtifact(classifier);
        }
      }
    }

    return artifacts;
  }

  private async extractNativeLibraries(
    versionId: string,
    versionFile: VersionFile,
    nativeArtifacts: Array<LibraryArtifact & { exclude?: string[] }>,
  ): Promise<void> {
    const nativeRoot = path.join(this.paths.nativesDir, versionId);
    const markerPath = path.join(nativeRoot, '.complete');
    const versionHash = createHash('sha1')
      .update(JSON.stringify({
        extractionVersion: 3,
        arch: process.arch,
        libraries: versionFile.libraries,
        nativeArtifacts: nativeArtifacts.map((artifact) => artifact.path),
      }))
      .digest('hex');

    if (await pathExists(markerPath)) {
      const marker = await readFile(markerPath, 'utf8');
      if (marker.trim() === versionHash) {
        return;
      }
    }

    await rm(nativeRoot, { recursive: true, force: true });
    await ensureDirectory(nativeRoot);

    let completed = 0;
    for (const artifact of nativeArtifacts) {
      const jarPath = path.join(this.paths.librariesDir, artifact.path);
      await downloadFile({
        url: artifact.url,
        destination: jarPath,
        expectedSha1: artifact.sha1,
        expectedSize: artifact.size,
        minimumSize: MIN_LIBRARY_ARTIFACT_BYTES,
      });

      const archiveBuffer = await readFile(jarPath);
      const entries = unzipSync(new Uint8Array(archiveBuffer));
      for (const [entryName, entryData] of Object.entries(entries)) {
        const normalized = entryName.replace(/\\/g, '/');
        if (normalized.endsWith('/')) {
          continue;
        }
        if (normalized.startsWith('META-INF/')) {
          continue;
        }
        if (artifact.exclude?.some((prefix) => normalized.startsWith(prefix))) {
          continue;
        }

        const outputName = nativeEntryOutputName(normalized);
        if (!outputName) {
          continue;
        }

        await writeFile(path.join(nativeRoot, outputName), Buffer.from(entryData));
      }

      completed += 1;
      this.updateProgress('natives', completed, nativeArtifacts.length, `Готовим системные библиотеки ${completed}/${nativeArtifacts.length}`);
    }

    await writeFile(markerPath, `${versionHash}\n`, 'utf8');
  }

  private async launchClient(context: LaunchContext): Promise<void> {
    if (this.launchProcess) {
      throw new Error('Minecraft уже запущен из этого лаунчера.');
    }

    if (!this.session) {
      throw new Error('Войдите в профиль перед запуском.');
    }

    const username = sanitizeUsername(this.session.username);
    const versionId = context.version.id;
    const versionDir = path.join(this.paths.versionsDir, versionId);
    const versionJarPath = path.join(versionDir, `${versionId}.jar`);
    const nativeRoot = path.join(this.paths.nativesDir, versionId);
    const loggingArgument = context.version.logging?.client
      ? substituteVariables(context.version.logging.client.argument, {
          path: path.join(this.paths.assetsDir, 'log_configs', context.version.logging.client.file.id),
        })
      : '';

    const classpathEntries = [
      ...this.collectLibraryArtifacts(context.version).map((artifact) => path.join(this.paths.librariesDir, artifact.path)),
      versionJarPath,
    ];

    const serverTarget = splitServerAddress(this.config.serverAddress);

    const variables: Record<string, string> = {
      auth_player_name: username,
      version_name: versionId,
      game_directory: this.paths.gameDir,
      assets_root: this.paths.assetsDir,
      assets_index_name: context.version.assetIndex.id,
      auth_uuid: toOfflineUuid(username),
      auth_access_token: 'offline-access-token',
      clientid: '',
      auth_xuid: '',
      version_type: context.version.type,
      launcher_name: this.launcherName,
      launcher_version: this.launcherVersion,
      classpath: classpathEntries.join(path.delimiter),
      natives_directory: nativeRoot,
      quickPlayPath: '',
      quickPlayMultiplayer: '',
      resolution_width: '1280',
      resolution_height: '720',
    };

    const features: Record<string, boolean> = {
      has_quick_plays_support: false,
      is_quick_play_multiplayer: false,
    };

    const defaultJvmArgs = expandArguments(context.version.arguments?.['default-user-jvm'], variables, features).filter(
      (argument) => !isMemoryArgument(argument),
    );
    const manifestJvmArgs = expandArguments(context.version.arguments?.jvm, variables, features).filter(
      (argument) => !isMemoryArgument(argument),
    );
    const gameArgs = expandArguments(context.version.arguments?.game, variables, features);
    if (serverTarget) {
      gameArgs.push('--server', serverTarget.host, '--port', serverTarget.port);
    }
    const normalizedJvmArgs = normalizeJvmArguments([
      ...defaultJvmArgs,
      ...(loggingArgument ? [loggingArgument] : []),
      ...manifestJvmArgs,
    ]);

    const javaArgs = [
      ...normalizedJvmArgs,
      `-Xms${this.config.minMemoryMb}M`,
      `-Xmx${this.config.maxMemoryMb}M`,
      context.version.mainClass,
      ...gameArgs,
    ];

    this.pushLog(`Запускаем Minecraft ${versionId}, Java: ${context.javaSource}.`);
    this.pushLog(`Профиль: ${this.session.login} -> ${username}.`);
    this.pushLog(`Сервер: ${this.config.serverAddress || 'ручной вход'}.`);

    this.launchProcess = spawn(context.javaPath, javaArgs, {
      cwd: this.paths.gameDir,
      stdio: 'pipe',
    });

    this.status.isLaunching = true;
    this.status.statusLine = 'Minecraft запускается...';
    this.emitSnapshot(this.getSnapshot());

    const launchLogPath = path.join(this.paths.logsDir, 'minecraft-launch.log');
    const handleStream = (label: 'stdout' | 'stderr', chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (!text) {
        return;
      }
      for (const line of text.split(/\r?\n/)) {
        this.pushLog(`${label}: ${line}`);
      }
      void appendFile(launchLogPath, chunk).catch(() => {});
    };

    this.launchProcess.stdout.on('data', (chunk: Buffer) => handleStream('stdout', chunk));
    this.launchProcess.stderr.on('data', (chunk: Buffer) => handleStream('stderr', chunk));
    this.launchProcess.on('error', (error) => {
      this.status.lastError = formatError(error);
      this.status.statusLine = this.status.lastError;
      this.status.isLaunching = false;
      this.launchProcess = null;
      this.emitSnapshot(this.getSnapshot());
    });
    this.launchProcess.on('exit', (code) => {
      this.pushLog(`Minecraft завершен с кодом ${code ?? 0}.`);
      this.status.isLaunching = false;
      this.status.statusLine = code === 0 ? 'Minecraft закрыт.' : `Minecraft завершен с кодом ${code ?? 0}.`;
      this.launchProcess = null;
      this.emitSnapshot(this.getSnapshot());
    });
  }
}
