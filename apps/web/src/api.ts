import { assertNoMeetingKey } from './e2ee/guard';

export type GuestMode = 'off' | 'waiting_room' | 'open';

export interface Meeting {
  id: string;
  code: string;
  title: string;
  waiting_room: boolean;
  locked: boolean;
  scheduled_at: string | null;
  /** When the meeting was created (ISO); absent on an API that predates the field. */
  created_at?: string;
  has_passcode: boolean;
  is_host?: boolean;
  /** End-to-end encrypted meeting (absent on an API that predates the feature: treated as false). */
  e2ee?: boolean;
  guest_mode?: GuestMode;
}

export interface JoinedResult {
  status: 'joined';
  token: string;
  url: string;
  meetingId: string;
  title: string;
  isHost: boolean;
  /** The media is end-to-end encrypted; the key comes from the link fragment and is never sent to the server. */
  e2ee?: boolean;
  /** The meeting's guest setting; sent to the host side only (the call screen can change it). */
  guestMode?: GuestMode;
  /** Set when the person joined as a guest (no account). */
  guest?: boolean;
  guestToken?: string;
}
export type JoinResult = JoinedResult | { status: 'waiting'; requestId: string };
export type GuestJoinResult = JoinedResult | { status: 'waiting'; requestId: string; guestToken: string };

export interface JoinRequest {
  id: string;
  user_id: string | null;
  display_name: string;
  email: string | null;
  guest?: boolean;
}

export interface RecordingStatus {
  enabled: boolean;
  e2ee: boolean;
  active: boolean;
  canRecord: boolean;
}

export interface RecordingSummary {
  id: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  sizeBytes: number | null;
  startedBy: string;
}

/** The person's personal room (owner decision 3, 2026-11-27); the passcode itself is never sent back. */
export interface PersonalRoom {
  code: string;
  title: string;
  waitingRoom: boolean;
  hasPasscode: boolean;
  guests: GuestMode;
}
export interface PersonalRoomView {
  room: PersonalRoom | null;
  policy: { requirePasscode: boolean; guestPolicy: GuestMode };
}
/** One ended run of a meeting ("Recent activity"): only what the server really recorded. */
export interface ActivityItem {
  id: string;
  meetingCode: string;
  title: string;
  personal: boolean;
  isHost: boolean;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  participants: number;
  guests: number;
  peak: number;
  files: number;
  recordings: number;
}
export interface MyRecording {
  id: string;
  meetingCode: string;
  title: string;
  startedAt: string;
  endedAt: string | null;
  sizeBytes: number | null;
}

/** The signed-in person's profile (owner decision 2 of the profile package). */
export interface Profile {
  name: string;
  email: string;
  jobTitle: string | null;
  departmentId: string | null;
  department: string | null;
  phone: string | null;
  timeZone: string | null;
  dateFormat: 'dmy' | 'mdy' | 'ymd' | null;
  timeFormat: '24h' | '12h' | null;
  avatarUrl: string | null;
  departments: Array<{ id: string; name: string }>;
}
export type ProfilePatch = Partial<Pick<Profile, 'jobTitle' | 'departmentId' | 'phone' | 'timeZone' | 'dateFormat' | 'timeFormat'>>;
export interface SecurityView {
  password: boolean;
  totp: Array<{ id: string; label: string | null; createdAt: string | null }>;
  passkeys: Array<{ id: string; label: string | null; createdAt: string | null }>;
  sessions: Array<{ id: string; current: boolean; start: string | null; lastAccess: string | null; device: string | null; browser: string | null; city: string | null; country: string | null; ip: string | null }>;
  links: Array<{ provider: string; userName: string | null }>;
  providers: string[];
}
export interface PersonCard {
  id: string;
  name: string;
  avatarUrl: string | null;
  jobTitle?: string | null;
  department?: string | null;
  email?: string;
  phone?: string | null;
}

/** One setting of "My settings" as the API lists it (src/settings/catalog.ts on the server). */
export interface SettingItem {
  key: string;
  group: 'security' | 'scheduling' | 'meeting' | 'notifications' | 'appearance' | 'recording' | 'organization';
  type: 'bool' | 'choice' | 'text' | 'countries' | 'int';
  options?: string[];
  max?: number;
  min?: number;
  value: boolean | string | string[] | number;
  orgValue: boolean | string | string[] | number;
  locked: boolean;
  orgOnly?: boolean;
  fromPolicy?: boolean;
}
export interface SettingsView {
  items: SettingItem[];
  recordingEnabled: boolean;
  mailEnabled: boolean;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly detail: string = '',
    /** The API's stable machine-readable code, when it sent one (e.g. "email_taken"). */
    public readonly code?: string,
    /** Further details the API sent with the refusal (e.g. the organization's join notice). */
    public readonly extra?: Record<string, unknown>,
  ) {
    super(`api ${status} ${detail}`);
  }
}

let sessionLost: ((token: string) => void) | null = null;
/** The app registers what to do when the API refuses the signed-in person's token (401). Guest tokens never reach it. */
export function onSessionLost(fn: ((token: string) => void) | null): void {
  sessionLost = fn;
}

async function call<T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const headers = { Authorization: `Bearer ${token}`, ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
  const body = init?.body !== undefined ? JSON.stringify(init.body) : undefined;
  assertNoMeetingKey({ url: `/api${path}`, headers, body }); // an E2EE meeting key never leaves the browser
  const res = await fetch(`/api${path}`, { method: init?.method ?? 'GET', headers, body });
  if (!res.ok) {
    if (res.status === 401) sessionLost?.(token);
    let detail = '';
    let code: string | undefined;
    let extra: Record<string, unknown> | undefined;
    try {
      const b = (await res.json()) as { message?: unknown; code?: unknown };
      detail = String(b.message ?? '');
      code = typeof b.code === 'string' ? b.code : undefined;
      extra = b as Record<string, unknown>;
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(res.status, detail, code, extra);
  }
  return (await res.json()) as T;
}

/** The "Get started" checklist (GET/PUT /v1/me/onboarding). */
export type OnboardingStepId = 'devices' | 'invite' | 'meeting' | 'guests' | 'email';
export interface OnboardingView {
  steps: Array<{ id: OnboardingStepId; done: boolean }>;
  dismissed: boolean;
  emailVerified: boolean;
  canSendVerification: boolean;
}

/**
 * Organization set-up after a first sign-in through Google or Microsoft. The token has no organization yet, so a 401 here
 * must not end the session (unlike call()): the caller shows the message instead.
 */
async function setupOrganization(token: string, orgName?: string, lang?: 'uz' | 'ru' | 'en'): Promise<{ slug: string }> {
  const res = await fetch('/api/v1/onboarding/organization', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(orgName ? { orgName } : {}), ...(lang ? { lang } : {}) }),
  });
  const b = (await res.json().catch(() => ({}))) as { slug?: string; code?: unknown; message?: unknown };
  if (res.status !== 201) throw new ApiError(res.status, String(b.message ?? ''), typeof b.code === 'string' ? b.code : undefined);
  return { slug: String(b.slug) };
}

const enc = encodeURIComponent;

/** Calls for people without an account: no sign-in, so no Authorization header (a guest session token only for polling). */
async function guestCall<T>(path: string, init: { method?: string; body?: unknown; bearer?: string }): Promise<T> {
  const headers = { ...(init.bearer ? { Authorization: `Bearer ${init.bearer}` } : {}), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) };
  const body = init.body !== undefined ? JSON.stringify(init.body) : undefined;
  assertNoMeetingKey({ url: `/api${path}`, headers, body });
  const res = await fetch(`/api${path}`, { method: init.method ?? 'GET', headers, body });
  if (!res.ok) {
    let detail = '';
    let code: string | undefined;
    let extra: Record<string, unknown> | undefined;
    try {
      const b = (await res.json()) as { message?: unknown; code?: unknown };
      detail = String(b.message ?? '');
      code = typeof b.code === 'string' ? b.code : undefined;
      extra = b as Record<string, unknown>;
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(res.status, detail, code, extra);
  }
  return (await res.json()) as T;
}

/** Uploads a file to the meeting (raw body, authorised by the bearer token). */
async function uploadFile(token: string, code: string, file: File): Promise<{ id: string; name: string; size: number }> {
  const url = `/api/v1/meetings/${enc(code)}/files?name=${enc(file.name)}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' };
  assertNoMeetingKey({ url, headers });
  const res = await fetch(url, { method: 'PUT', headers, body: file });
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

async function downloadRecording(token: string, id: string): Promise<Blob> {
  const res = await fetch(`/api/v1/recordings/${enc(id)}/download`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new ApiError(res.status);
  return res.blob();
}

export const api = {
  uploadFile,
  downloadFile,
  downloadRecording,
  recordingStatus: (token: string, code: string) => call<RecordingStatus>(token, `/v1/meetings/${enc(code)}/recording`),
  startRecording: (token: string, code: string, confirmed?: boolean) =>
    call<{ id: string; status: string }>(token, `/v1/meetings/${enc(code)}/recording/start`, { method: 'POST', body: confirmed ? { confirmed: true } : {} }),
  stopRecording: (token: string, code: string) => call<{ id: string; status: string }>(token, `/v1/meetings/${enc(code)}/recording/stop`, { method: 'POST', body: {} }),
  recordings: (token: string, code: string) => call<RecordingSummary[]>(token, `/v1/meetings/${enc(code)}/recordings`),
  list: (token: string) => call<Meeting[]>(token, '/v1/meetings'),
  personalRoom: (token: string) => call<PersonalRoomView>(token, '/v1/me/personal-room'),
  ensurePersonalRoom: (token: string, body: { title: string; passcode?: string }) => call<PersonalRoom>(token, '/v1/me/personal-room', { method: 'POST', body }),
  updatePersonalRoom: (token: string, patch: { passcode?: string | null; waitingRoom?: boolean; guests?: GuestMode }) =>
    call<PersonalRoom>(token, '/v1/me/personal-room', { method: 'PATCH', body: patch }),
  regeneratePersonalRoom: (token: string) => call<PersonalRoom>(token, '/v1/me/personal-room/regenerate', { method: 'POST', body: {} }),
  recentActivity: (token: string, limit = 10) => call<{ items: ActivityItem[] }>(token, `/v1/me/activity?limit=${limit}`),
  connectionTest: (token: string) => call<{ url: string; token: string; room: string }>(token, '/v1/me/connection-test', { method: 'POST', body: {} }),
  profile: (token: string) => call<Profile>(token, '/v1/me/profile'),
  saveProfile: (token: string, patch: ProfilePatch) => call<Profile>(token, '/v1/me/profile', { method: 'PUT', body: patch }),
  uploadAvatar: async (token: string, image: Blob): Promise<{ avatarUrl: string }> => {
    const res = await fetch('/api/v1/me/avatar', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: image });
    if (!res.ok) {
      let code: string | undefined;
      try {
        code = ((await res.json()) as { code?: string }).code;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, '', code);
    }
    return (await res.json()) as { avatarUrl: string };
  },
  removeAvatar: async (token: string): Promise<void> => {
    const res = await fetch('/api/v1/me/avatar', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new ApiError(res.status);
  },
  security: (token: string) => call<SecurityView>(token, '/v1/me/security'),
  endSession: async (token: string, sid: string): Promise<void> => {
    const res = await fetch(`/api/v1/me/security/sessions/${enc(sid)}/end`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new ApiError(res.status);
  },
  endAllSessions: async (token: string): Promise<void> => {
    const res = await fetch('/api/v1/me/security/sessions/end-all', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new ApiError(res.status);
  },
  unlinkProvider: async (token: string, provider: string): Promise<void> => {
    const res = await fetch(`/api/v1/me/security/links/${enc(provider)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      let code: string | undefined;
      try {
        code = ((await res.json()) as { code?: string }).code;
      } catch {
        /* not JSON */
      }
      throw new ApiError(res.status, '', code);
    }
  },
  person: (token: string, userId: string) => call<PersonCard>(token, `/v1/people/${enc(userId)}`),
  myRecordings: (token: string) => call<{ enabled: boolean; items: MyRecording[] }>(token, '/v1/recordings'),
  trial: (token: string) => call<TrialStatus>(token, '/v1/trial'),
  onboarding: (token: string) => call<OnboardingView>(token, '/v1/me/onboarding'),
  setOnboarding: (token: string, patch: { devicesTested?: true; meetingJoined?: true; dismissed?: true }) => call<OnboardingView>(token, '/v1/me/onboarding', { method: 'PUT', body: patch }),
  sendVerification: (token: string) => call<{ sent: boolean }>(token, '/v1/me/verify-email', { method: 'POST', body: {} }),
  setupOrganization,
  getPrefs: (token: string) =>
    call<{ prefs: { lang: string | null; theme: string | null; style: string | null; density: string | null }; org: { defaultStyle: string; defaultDensity: string; allowedStyles: string[] | null } }>(token, '/v1/me/prefs'),
  putPrefs: (token: string, patch: Partial<Record<'lang' | 'theme' | 'style' | 'density', string | null>>) => call<unknown>(token, '/v1/me/prefs', { method: 'PUT', body: patch }),
  settings: (token: string) => call<{ guestPolicy: GuestMode }>(token, '/v1/meetings/settings'),
  guestJoin: (code: string, name: string, passcode?: string, acceptDisclaimer?: boolean) =>
    guestCall<GuestJoinResult>(`/v1/guest/meetings/${enc(code)}/join`, { method: 'POST', body: { name, ...(passcode ? { passcode } : {}), ...(acceptDisclaimer ? { acceptDisclaimer: true } : {}) } }),
  guestStatus: (guestToken: string, id: string) => guestCall<JoinedResult | { status: 'waiting' }>(`/v1/guest/requests/${enc(id)}`, { bearer: guestToken }),
  create: (token: string, body: { title: string; passcode?: string; waitingRoom?: boolean; e2ee?: boolean; guests?: GuestMode; scheduledAt?: string }) =>
    call<Meeting>(token, '/v1/meetings', { method: 'POST', body }),
  join: (token: string, code: string, passcode?: string, acceptDisclaimer?: boolean) =>
    call<JoinResult>(token, `/v1/meetings/${enc(code)}/join`, { method: 'POST', body: { passcode, ...(acceptDisclaimer ? { acceptDisclaimer: true } : {}) } }),
  mySettings: (token: string) => call<SettingsView>(token, '/v1/me/settings'),
  saveMySettings: (token: string, patch: Record<string, unknown>) => call<SettingsView>(token, '/v1/me/settings', { method: 'PUT', body: patch }),
  orgSettings: (token: string) => call<SettingsView>(token, '/v1/admin/settings'),
  saveOrgSettings: (token: string, patch: Record<string, unknown>) => call<SettingsView>(token, '/v1/admin/settings', { method: 'PUT', body: patch }),
  cancelMeeting: (token: string, code: string) => call<{ cancelled: true }>(token, `/v1/meetings/${enc(code)}`, { method: 'DELETE' }),
  rename: (token: string, code: string, name: string) => call<{ name: string }>(token, `/v1/meetings/${enc(code)}/rename`, { method: 'POST', body: { name } }),
  requestStatus: (token: string, code: string, id: string) =>
    call<JoinedResult | { status: 'waiting' }>(token, `/v1/meetings/${enc(code)}/requests/${enc(id)}`),
  listRequests: (token: string, code: string) => call<JoinRequest[]>(token, `/v1/meetings/${enc(code)}/requests`),
  decide: (token: string, code: string, id: string, admit: boolean) =>
    call<{ status: string }>(token, `/v1/meetings/${enc(code)}/requests/${enc(id)}/${admit ? 'admit' : 'deny'}`, { method: 'POST', body: {} }),
  /** Host side: closes the meeting's room for everyone. */
  endMeeting: (token: string, code: string) => call<{ ended: true }>(token, `/v1/meetings/${enc(code)}/end`, { method: 'POST', body: {} }),
  /** Host side: who may join without an account, within the organization's limit. */
  setGuests: (token: string, code: string, guests: GuestMode) =>
    call<{ guest_mode: GuestMode }>(token, `/v1/meetings/${enc(code)}`, { method: 'PATCH', body: { guests } }),
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
  activity: (token: string, code: string, event: string) => call<{ recorded: true }>(token, `/v1/meetings/${enc(code)}/activity`, { method: 'POST', body: { event } }),
  muteAll: (token: string, code: string) => call<{ muted: number }>(token, `/v1/meetings/${enc(code)}/mute-all`, { method: 'POST', body: {} }),
  spotlight: (token: string, code: string, identity: string | null) =>
    call<{ spotlight: string | null }>(token, `/v1/meetings/${enc(code)}/spotlight`, { method: 'POST', body: { identity } }),
};
