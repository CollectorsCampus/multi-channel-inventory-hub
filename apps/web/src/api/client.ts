/**
 * Thin fetch wrapper for the REST API.
 *
 * Handles the double-submit CSRF contract: the server sets a readable
 * `hub_csrf` cookie at login, and every state-changing request must echo it in
 * the X-CSRF-Token header. See apps/api/src/auth/auth.guard.ts.
 */

const CSRF_COOKIE = 'hub_csrf';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * The full error payload.
     *
     * Kept because the API returns structured detail alongside the summary —
     * per-field `issues` for an invalid channel config, ledger `issues` for a
     * breached allocation invariant. Reducing an error to its `message` throws
     * away exactly the part worth showing an operator.
     */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Per-field validation issues, when the endpoint reported any. */
  get issues(): Array<{ field?: string; code?: string; message: string }> {
    const issues = (this.body as { issues?: unknown } | undefined)?.issues;
    return Array.isArray(issues) ? issues : [];
  }
}

function readCsrfToken(): string | undefined {
  return document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${CSRF_COOKIE}=`))
    ?.split('=')[1];
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);

  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (UNSAFE_METHODS.has(method)) {
    const csrf = readCsrfToken();
    if (csrf) headers.set('X-CSRF-Token', decodeURIComponent(csrf));
  }

  const response = await fetch(`/api${path}`, {
    ...init,
    method,
    headers,
    // Session cookie is httpOnly; it only travels if we ask for it.
    credentials: 'same-origin',
  });

  if (response.status === 204) return undefined as T;

  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const raw = (payload as { message?: unknown } | undefined)?.message;
    // NestJS reports ValidationPipe failures as an array of messages.
    const message = Array.isArray(raw)
      ? raw.join(', ')
      : raw !== undefined
        ? String(raw)
        : `Request failed with status ${response.status}`;

    throw new ApiError(response.status, message, payload);
  }

  return payload as T;
}

export interface AuthStatus {
  needsSetup: boolean;
  providerKey: string;
  providerDisplayName: string;
  supportsDirectLogin: boolean;
}

export interface CurrentUser {
  userId: string;
  username: string;
  role: 'viewer' | 'editor' | 'admin';
}

export const authApi = {
  status: () => apiFetch<AuthStatus>('/auth/status'),
  me: () => apiFetch<CurrentUser>('/auth/me'),
  login: (username: string, password: string) =>
    apiFetch<CurrentUser>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  setup: (username: string, password: string) =>
    apiFetch<{ ok: true }>('/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => apiFetch<void>('/auth/logout', { method: 'POST' }),
};
