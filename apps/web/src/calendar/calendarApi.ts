import { ApiError } from '../api';
import type { CalProvider, EventBody } from './logic';

export interface ProviderStatus {
  provider: CalProvider;
  configured: boolean;
  connected: boolean;
}

async function call<T>(token: string, path: string, init?: { method?: string; body?: unknown; json?: boolean }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.json ? { Accept: 'application/json' } : {}),
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export interface CalendarApi {
  status: (token: string) => Promise<ProviderStatus[]>;
  /** The provider's consent page URL; the caller navigates to it (a fetch cannot follow the 302 with the bearer token). */
  start: (token: string, provider: CalProvider) => Promise<{ url: string }>;
  disconnect: (token: string, provider: CalProvider) => Promise<{ disconnected: boolean }>;
  createEvent: (token: string, code: string, body: EventBody) => Promise<{ eventUrl: string }>;
}

export const calendarApi: CalendarApi = {
  status: (token) => call(token, '/v1/calendar'),
  start: (token, provider) => call(token, `/v1/calendar/${enc(provider)}/start`, { json: true }),
  disconnect: (token, provider) => call(token, `/v1/calendar/${enc(provider)}`, { method: 'DELETE' }),
  createEvent: (token, code, body) => call(token, `/v1/meetings/${enc(code)}/calendar-event`, { method: 'POST', body }),
};
