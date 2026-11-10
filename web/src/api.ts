// demo.ts imports ApiError from here but only uses it inside functions, so the cycle is safe.
import { demoApi } from './demo';

export interface User {
  id: string;
  phone: string;
}

export interface Style {
  id: string;
  label: string;
}

export type PortraitStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface Portrait {
  id: string;
  name: string;
  style: string;
  status: PortraitStatus;
  error: string | null;
  imageUrl: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter?: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === 'string') headers.set('content-type', 'application/json');
  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    const retry = Number(res.headers.get('retry-after')) || undefined;
    throw new ApiError(res.status, body.error ?? `Request failed (${res.status})`, retry);
  }
  return body as T;
}

const httpApi = {
  me: () => request<{ user: User | null }>('/api/me'),
  requestOtp: (phone: string) => request<void>('/api/auth/otp', { method: 'POST', body: JSON.stringify({ phone }) }),
  verifyOtp: (phone: string, code: string) =>
    request<{ user: User }>('/api/auth/verify', { method: 'POST', body: JSON.stringify({ phone, code }) }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  styles: () => request<{ styles: Style[] }>('/api/styles'),
  portraits: () => request<{ portraits: Portrait[] }>('/api/portraits'),
  createPortrait: (form: FormData) => request<{ portrait: Portrait }>('/api/portraits', { method: 'POST', body: form }),
};

/** The GitHub Pages build has no server, so it swaps in an in-browser implementation. */
export const DEMO_MODE = import.meta.env.VITE_DEMO === '1';
export const api: typeof httpApi = DEMO_MODE ? demoApi : httpApi;
