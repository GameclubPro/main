export interface FlexUser {
  id: string;
  login: string;
  nickname: string;
  nicknameSet?: boolean;
  displayName?: string;
  avatarUrl?: string;
  linkedProviders?: string[];
  identities?: FlexIdentity[];
  player?: FlexPlayer | null;
  createdAt: string;
}

export interface FlexPlayer {
  id: string;
  userId: string;
  nickname: string;
  nicknameSet: boolean;
  stats?: Record<string, unknown>;
  lastSeenAt?: string;
  updatedAt?: string;
  createdAt?: string;
}

export interface FlexIdentity {
  provider: string;
  providerUserId: string;
  displayName?: string;
  avatarUrl?: string;
  profileUrl?: string;
  linkedAt?: string;
  updatedAt?: string;
}

export interface AuthProvider {
  id: string;
  label: string;
  enabled: boolean;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  error?: string;
  user?: FlexUser | null;
  providers?: AuthProvider[];
  status?: string;
  token?: string;
  deviceCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresIn?: number;
  interval?: number;
  data?: T;
}

const apiBase = `${window.location.origin}/api`;

async function parseApiResponse<T>(response: Response): Promise<ApiResult<T>> {
  const payload = (await response.json().catch(() => ({}))) as ApiResult<T>;

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `HTTP ${response.status}`);
  }

  return payload;
}

export async function apiGet<T>(path: string): Promise<ApiResult<T>> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });
  return parseApiResponse<T>(response);
}

export async function apiPost<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  const response = await fetch(`${apiBase}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parseApiResponse<T>(response);
}

export function apiError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
