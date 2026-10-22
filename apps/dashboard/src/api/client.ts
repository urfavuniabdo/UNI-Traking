import type { ApiErrorCode } from './types';
import { isMockMode, mockFetch } from '@/dev/mock';

export const API_BASE: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000/api/v1';

/** Mock switch — the ONLY difference between mock and real backend. */
export const isMock: boolean = import.meta.env.VITE_USE_MOCK === '1';

export class ApiError extends Error {
  status: number;
  code: ApiErrorCode | string | undefined;
  payload: unknown;

  constructor(status: number, message: string, code?: string, payload?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code as ApiErrorCode | undefined;
    this.payload = payload;
  }

  /** e.g. `FORBIDDEN_ROLE:ADMIN` style helpers */
  is(code: ApiErrorCode | string): boolean {
    return this.code === code || (code.startsWith('FORBIDDEN_ROLE:') && String(this.code).startsWith(code));
  }
}

interface AuthTokens {
  accessToken: string | null;
  refreshToken: string | null;
}

/** Read tokens straight from the persisted auth store (avoids circular imports). */
function readTokens(): AuthTokens {
  try {
    const raw = localStorage.getItem('traccer.auth');
    if (!raw) return { accessToken: null, refreshToken: null };
    const parsed = JSON.parse(raw) as { state?: { token?: string; refreshToken?: string } };
    return {
      accessToken: parsed.state?.token ?? null,
      refreshToken: parsed.state?.refreshToken ?? null,
    };
  } catch {
    return { accessToken: null, refreshToken: null };
  }
}

function writeTokens(t: AuthTokens) {
  try {
    const raw = localStorage.getItem('traccer.auth');
    if (!raw) return;
    const parsed = JSON.parse(raw) as { state: Record<string, unknown> };
    parsed.state.token = t.accessToken;
    parsed.state.refreshToken = t.refreshToken;
    localStorage.setItem('traccer.auth', JSON.stringify(parsed));
  } catch {
    /* ignore */
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;

function buildUrl(path: string, query?: Query): string {
  const qs = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
  }
  const q = qs.toString();
  return `${API_BASE}${path}${q ? `?${q}` : ''}`;
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  /** skip the automatic 401→refresh→retry cycle (used by /auth/refresh itself) */
  noAuth?: boolean;
}

interface RawResponse {
  status: number;
  json: unknown;
}

async function rawFetch(method: string, url: string, body: unknown, token: string | null): Promise<RawResponse> {
  if (isMockMode()) {
    const u = new URL(url);
    const query = Object.fromEntries(u.searchParams.entries());
    return mockFetch(method, u.pathname.replace(/^\/api\/v1/, ''), query, body);
  }
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/** Single-flight refresh queue: parallel 401s share one refresh call. */
let refreshInFlight: Promise<string | null> | null = null;

/** Also used by the realtime socket, which authenticates outside this request path. */
export async function refreshOnce(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const { refreshToken } = readTokens();
      if (!refreshToken) return null;
      try {
        const res = await rawFetch(
          'POST',
          buildUrl('/auth/refresh'),
          { refreshToken },
          null,
        );
        if (res.status >= 400) return null;
        const json = res.json as { accessToken?: string; refreshToken?: string };
        if (!json.accessToken) return null;
        writeTokens({ accessToken: json.accessToken, refreshToken: json.refreshToken ?? refreshToken });
        return json.accessToken;
      } catch {
        return null;
      } finally {
        // allow next refresh later
        setTimeout(() => (refreshInFlight = null), 0);
      }
    })();
  }
  return refreshInFlight;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, opts.query);
  let token = opts.noAuth ? null : readTokens().accessToken;
  let res = await rawFetch(method, url, opts.body, token);

  if (res.status === 401 && !opts.noAuth) {
    const newToken = await refreshOnce();
    if (newToken) {
      token = newToken;
      res = await rawFetch(method, url, opts.body, token);
    } else {
      // hard logout
      localStorage.removeItem('traccer.auth');
      if (!window.location.pathname.startsWith('/login')) {
        window.location.assign('/login');
      }
    }
  }

  if (res.status >= 400) {
    const payload = res.json as { message?: string; code?: string; error?: { code?: string; message?: string } };
    const code = payload?.code ?? payload?.error?.code;
    const message = payload?.message ?? payload?.error?.message ?? `HTTP ${res.status}`;
    throw new ApiError(res.status, message, code, res.json);
  }
  return res.json as T;
}

export const api = {
  get: <T>(path: string, query?: Query, opts?: Omit<RequestOptions, 'query'>) =>
    request<T>('GET', path, { query, ...opts }),
  post: <T>(path: string, body?: unknown, query?: Query, opts?: Omit<RequestOptions, 'query'>) =>
    request<T>('POST', path, { body, query, ...opts }),
  patch: <T>(path: string, body?: unknown, query?: Query) => request<T>('PATCH', path, { body, query }),
  put: <T>(path: string, body?: unknown, query?: Query) => request<T>('PUT', path, { body, query }),
  del: <T>(path: string, query?: Query) => request<T>('DELETE', path, { query }),
};

/** Download a CSV (or any text) report via `?format=csv`, authenticated. */
export async function downloadCsv(path: string, query?: Query, filename?: string): Promise<void> {
  const q = { ...(query ?? {}), format: 'csv' };
  const token = readTokens().accessToken;
  if (isMockMode()) {
    const u = new URL(buildUrl(path, q));
    const res = await mockFetch(
      'GET',
      u.pathname.replace(/^\/api\/v1/, ''),
      Object.fromEntries(u.searchParams.entries()),
      undefined,
    );
    const csv = (res.json as { csv: string }).csv;
    triggerDownload(csv, filename ?? `${path.split('/').pop()}.csv`);
    return;
  }
  const res = await fetch(buildUrl(path, q), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, 'CSV download failed', undefined, await res.text());
  triggerDownload(await res.text(), filename ?? `${path.split('/').pop()}.csv`);
}

function triggerDownload(content: string, filename: string) {
  const blob = new Blob(['\ufeff' + content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
