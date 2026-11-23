export interface Meeting {
  id: string;
  code: string;
  title: string;
  waiting_room: boolean;
  locked: boolean;
  scheduled_at: string | null;
  has_passcode: boolean;
  is_host?: boolean;
}

export interface JoinedResult {
  status: 'joined';
  token: string;
  url: string;
  meetingId: string;
  title: string;
  isHost: boolean;
}
export type JoinResult = JoinedResult | { status: 'waiting'; requestId: string };

export interface JoinRequest {
  id: string;
  user_id: string;
  display_name: string;
  email: string;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly detail: string = '') {
    super(`api ${status} ${detail}`);
  }
}

async function call<T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = String(((await res.json()) as { message?: unknown }).message ?? '');
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  list: (token: string) => call<Meeting[]>(token, '/v1/meetings'),
  create: (token: string, body: { title: string; passcode?: string; waitingRoom?: boolean }) =>
    call<Meeting>(token, '/v1/meetings', { method: 'POST', body }),
  join: (token: string, code: string, passcode?: string) =>
    call<JoinResult>(token, `/v1/meetings/${enc(code)}/join`, { method: 'POST', body: { passcode } }),
  requestStatus: (token: string, code: string, id: string) =>
    call<JoinedResult | { status: 'waiting' }>(token, `/v1/meetings/${enc(code)}/requests/${enc(id)}`),
  listRequests: (token: string, code: string) => call<JoinRequest[]>(token, `/v1/meetings/${enc(code)}/requests`),
  decide: (token: string, code: string, id: string, admit: boolean) =>
    call<{ status: string }>(token, `/v1/meetings/${enc(code)}/requests/${enc(id)}/${admit ? 'admit' : 'deny'}`, { method: 'POST', body: {} }),
  lock: (token: string, code: string, locked: boolean) =>
    call<{ locked: boolean }>(token, `/v1/meetings/${enc(code)}/lock`, { method: 'POST', body: { locked } }),
  mute: (token: string, code: string, identity: string) =>
    call<{ muted: number }>(token, `/v1/meetings/${enc(code)}/participants/${enc(identity)}/mute`, { method: 'POST', body: {} }),
  remove: (token: string, code: string, identity: string) =>
    call<{ removed: boolean }>(token, `/v1/meetings/${enc(code)}/participants/${enc(identity)}/remove`, { method: 'POST', body: {} }),
};
