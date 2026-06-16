export interface FlexUser {
  id: string;
  login: string;
  nickname: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface ApiResult<T = unknown> {
  ok: boolean;
  error?: string;
  user?: FlexUser | null;
  emailSent?: boolean;
  status?: string;
  token?: string;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
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
