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

/** Uploads a file to the meeting (raw body, authorised by the bearer token). */
async function uploadFile(token: string, code: string, file: File): Promise<{ id: string; name: string; size: number }> {
  const res = await fetch(`/api/v1/meetings/${enc(code)}/files?name=${enc(file.name)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = String(((await res.json()) as { message?: unknown }).message ?? '');
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as { id: string; name: string; size: number };
}

async function downloadFile(token: string, code: string, id: string): Promise<Blob> {
  const res = await fetch(`/api/v1/meetings/${enc(code)}/files/${enc(id)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status);
  return res.blob();
}

export interface TrialStatus {
  trial: boolean;
  expired: boolean;
  endsAt: string | null;
  maxParticipants: number | null;
  maxMinutes: number | null;
}

export const api = {
  uploadFile,
  downloadFile,
  list: (token: string) => call<Meeting[]>(token, '/v1/meetings'),
  trial: (token: string) => call<TrialStatus>(token, '/v1/trial'),
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
  me: (token: string, code: string) => call<{ role: 'host' | 'cohost' | 'member' }>(token, `/v1/meetings/${enc(code)}/me`),
  cohosts: (token: string, code: string) => call<string[]>(token, `/v1/meetings/${enc(code)}/cohosts`),
  setCohost: (token: string, code: string, identity: string, grant: boolean) =>
    call<{ cohost: boolean }>(token, `/v1/meetings/${enc(code)}/cohosts/${enc(identity)}/${grant ? 'grant' : 'revoke'}`, { method: 'POST', body: {} }),
  mute: (token: string, code: string, identity: string) =>
    call<{ muted: number }>(token, `/v1/meetings/${enc(code)}/participants/${enc(identity)}/mute`, { method: 'POST', body: {} }),
  remove: (token: string, code: string, identity: string) =>
    call<{ removed: boolean }>(token, `/v1/meetings/${enc(code)}/participants/${enc(identity)}/remove`, { method: 'POST', body: {} }),
};
