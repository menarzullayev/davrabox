export interface Meeting {
  id: string;
  code: string;
  title: string;
  waiting_room: boolean;
  locked: boolean;
  scheduled_at: string | null;
  has_passcode: boolean;
}

export interface JoinResult {
  token: string;
  url: string;
  meetingId: string;
  title: string;
  isHost: boolean;
}

export class ApiError extends Error {
  constructor(public readonly status: number) {
    super(`api ${status}`);
  }
}

async function call<T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}

export const api = {
  list: (token: string) => call<Meeting[]>(token, '/v1/meetings'),
  create: (token: string, body: { title: string; passcode?: string }) =>
    call<Meeting>(token, '/v1/meetings', { method: 'POST', body }),
  join: (token: string, code: string, passcode?: string) =>
    call<JoinResult>(token, `/v1/meetings/${encodeURIComponent(code)}/join`, { method: 'POST', body: { passcode } }),
};
