import { ApiError } from '../api';
import type { ApiKeyScope, DeliveryStatus, WebhookEvent } from './integrations-helpers';

export type Role = 'org_admin' | 'member';
export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  department: { id: string; name: string } | null;
  disabled: boolean;
  createdAt: string;
}
export interface Overview {
  org: { name: string; slug: string };
  users: number;
  seatsLimit: number | null;
  meetingsLast30d: number;
}
export interface Department {
  id: string;
  name: string;
  userCount: number;
}
export interface Policies {
  requirePasscode: boolean;
  waitingRoomDefault: boolean;
  maxParticipants: number;
  requireTotp: boolean;
  guestPolicy: 'off' | 'waiting_room' | 'open';
  defaultStyle: string;
  defaultDensity: string;
  /** null = every style is allowed. */
  allowedStyles: string[] | null;
}
export interface AuditEntry {
  id: string;
  at: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  target: string | null;
}
export interface Page<T> {
  items: T[];
  next: string | null;
}
export interface AuditFilters {
  from?: string;
  to?: string;
  action?: string;
  actor?: string;
  target?: string;
}
export type ExportFormat = 'csv' | 'json' | 'cef';
export interface VerifyResult {
  ok: boolean;
  checked: number;
  firstBrokenId: string | null;
}
export interface NewUser {
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  departmentId?: string;
}
export interface UserPatch {
  role?: Role;
  departmentId?: string | null;
  disabled?: boolean;
}

export interface ApiKeyItem {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}
export interface WebhookItem {
  id: string;
  url: string;
  events: WebhookEvent[];
  createdAt: string;
}
export interface DeliveryItem {
  id: string;
  eventId: string;
  eventType: string;
  status: DeliveryStatus;
  attempts: number;
  lastStatus: number | null;
  lastError: string | null;
  nextAttemptAt: string;
  createdAt: string;
  deliveredAt: string | null;
}

export interface KmsView {
  configured: boolean;
  provider?: 'vault-transit';
  addr?: string;
  keyName?: string;
  mount?: string;
  namespace?: string;
  kekId?: string;
  status?: 'unknown' | 'ok' | 'denied' | 'unreachable';
  checkedAt?: string | null;
  createdAt?: string;
  rotatedAt?: string | null;
  wrapped?: { files: number; recordings: number };
}
export interface KmsInput {
  addr: string;
  token: string;
  keyName: string;
  mount?: string;
  namespace?: string;
}
export interface RewrapResult {
  processed: number;
  failed: number;
  remaining: number;
  next: string | null;
}

type Query = Record<string, string | number | null | undefined>;

/** Builds `?a=1&b=x%20y`, skipping undefined, null and empty values; keys keep insertion order. */
export function buildQuery(params: Query): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Pulls `message` out of a `{statusCode,message}` error body (Nest validation errors use an array). */
export function errorDetail(body: unknown): string {
  if (body === null || typeof body !== 'object') return '';
  const m = (body as { message?: unknown }).message;
  if (Array.isArray(m)) return m.map(String).join('; ');
  return typeof m === 'string' ? m : '';
}

export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      const n = decodeURIComponent(star[1].trim());
      if (n) return safeName(n, fallback);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(header);
  return plain?.[1] ? safeName(plain[1].trim(), fallback) : fallback;
}

/** Strips path parts so a server-supplied name can never point outside the downloads folder. */
function safeName(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base && base !== '.' && base !== '..' ? base : fallback;
}

const EXPORT_EXT: Record<ExportFormat, string> = { csv: 'csv', json: 'jsonl', cef: 'cef' };

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const enc = encodeURIComponent;

export function createAdminClient(getToken: () => Promise<string>, fetchFn: FetchFn = (i, init) => fetch(i, init)) {
  async function raw(path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
    const token = await getToken();
    const res = await fetchFn(`/api${path}`, {
      method: init?.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      let detail = '';
      try {
        detail = errorDetail(await res.json());
      } catch {
        /* body was not JSON */
      }
      throw new ApiError(res.status, detail);
    }
    return res;
  }

  async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const res = await raw(path, init);
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    overview: () => call<Overview>('/v1/admin/overview'),
    listUsers: (p: { search?: string; limit?: number; cursor?: string | null }) =>
      call<Page<AdminUser>>(`/v1/admin/users${buildQuery({ search: p.search?.trim(), limit: p.limit, cursor: p.cursor })}`),
    createUser: (body: NewUser) => call<{ user: AdminUser; temporaryPassword: string }>('/v1/admin/users', { method: 'POST', body }),
    updateUser: (id: string, body: UserPatch) => call<AdminUser>(`/v1/admin/users/${enc(id)}`, { method: 'PATCH', body }),
    listDepartments: () => call<Department[]>('/v1/admin/departments'),
    createDepartment: (name: string) => call<Department>('/v1/admin/departments', { method: 'POST', body: { name } }),
    renameDepartment: (id: string, name: string) => call<Department>(`/v1/admin/departments/${enc(id)}`, { method: 'PATCH', body: { name } }),
    deleteDepartment: (id: string) => call<void>(`/v1/admin/departments/${enc(id)}`, { method: 'DELETE' }),
    getPolicies: () => call<Policies>('/v1/admin/policies'),
    putPolicies: (body: Policies) => call<Policies>('/v1/admin/policies', { method: 'PUT', body }),
    listAudit: (f: AuditFilters & { limit?: number; cursor?: string | null }) =>
      call<Page<AuditEntry>>(
        `/v1/admin/audit${buildQuery({ from: f.from, to: f.to, action: f.action?.trim(), actor: f.actor?.trim(), target: f.target?.trim(), limit: f.limit, cursor: f.cursor })}`,
      ),
    /** Downloads through fetch so the Authorization header is sent; the caller saves the blob. */
    async exportAudit(format: ExportFormat, f: Pick<AuditFilters, 'from' | 'to' | 'action'>): Promise<{ blob: Blob; filename: string }> {
      const res = await raw(`/v1/admin/audit/export${buildQuery({ format, from: f.from, to: f.to, action: f.action?.trim() })}`);
      const blob = await res.blob();
      return { blob, filename: filenameFromDisposition(res.headers.get('Content-Disposition'), `audit.${EXPORT_EXT[format]}`) };
    },
    verifyAudit: () => call<VerifyResult>('/v1/admin/audit/verify'),
    // Privacy: export of one person's data (a file, like the audit export) and erasure by anonymisation.
    async exportUserData(id: string): Promise<{ blob: Blob; filename: string }> {
      const res = await raw(`/v1/admin/users/${enc(id)}/export`);
      return { blob: await res.blob(), filename: filenameFromDisposition(res.headers.get('Content-Disposition'), 'davrabox-export.json') };
    },
    eraseUser: (id: string, confirm: string) =>
      call<{ status: 'erased'; alreadyErased: boolean }>(`/v1/admin/users/${enc(id)}`, { method: 'DELETE', body: { confirm } }),
    // Integrations. The secrets returned by the two create calls are shown once and never kept by the client.
    listApiKeys: () => call<ApiKeyItem[]>('/v1/admin/api-keys'),
    createApiKey: (body: { name: string; scopes: ApiKeyScope[] }) => call<ApiKeyItem & { secret: string }>('/v1/admin/api-keys', { method: 'POST', body }),
    revokeApiKey: (id: string) => call<void>(`/v1/admin/api-keys/${enc(id)}`, { method: 'DELETE' }),
    listWebhooks: () => call<WebhookItem[]>('/v1/admin/webhooks'),
    createWebhook: (body: { url: string; events: WebhookEvent[] }) => call<WebhookItem & { secret: string }>('/v1/admin/webhooks', { method: 'POST', body }),
    deleteWebhook: (id: string) => call<void>(`/v1/admin/webhooks/${enc(id)}`, { method: 'DELETE' }),
    listDeliveries: (id: string, p: { status?: DeliveryStatus; limit?: number; cursor?: string | null }) =>
      call<Page<DeliveryItem>>(`/v1/admin/webhooks/${enc(id)}/deliveries${buildQuery({ status: p.status, limit: p.limit, cursor: p.cursor })}`),
    // Encryption keys (BYOK). The token goes out in putKms only and is never returned by the server.
    getKms: () => call<KmsView>('/v1/admin/kms'),
    putKms: (body: KmsInput) => call<KmsView>('/v1/admin/kms', { method: 'PUT', body }),
    removeKms: () => call<{ removed: true }>('/v1/admin/kms', { method: 'DELETE' }),
    testKms: () => call<{ status: 'ok' | 'denied' | 'unreachable' }>('/v1/admin/kms/test', { method: 'POST' }),
    rewrapKms: (body: { target: 'customer' | 'platform'; limit?: number; after?: string }) => call<RewrapResult>('/v1/admin/kms/rewrap', { method: 'POST', body }),
    // Help assistant conversations: platform owner only (the server refuses everyone else with 403).
    assistantOwner: () => call<{ owner: boolean }>('/v1/platform/assistant/owner'),
    assistantUsage: () => call<AssistantUsage>('/v1/platform/assistant/usage'),
    assistantList: (p: { before?: string | null; limit?: number }) => call<Page<AssistantConversation>>(`/v1/platform/assistant/conversations${buildQuery({ before: p.before, limit: p.limit })}`),
    assistantMessages: (id: string) => call<{ items: AssistantMessage[] }>(`/v1/platform/assistant/conversations/${enc(id)}`),
    assistantDelete: (id: string) => call<void>(`/v1/platform/assistant/conversations/${enc(id)}`, { method: 'DELETE' }),
  };
}

export type AdminClient = ReturnType<typeof createAdminClient>;

export interface AssistantUsage {
  day: string;
  llm: 'none' | 'anthropic' | 'claude-cli';
  model: string | null;
  llmRequests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  dailyUsdCap: number;
  dailyLlmRequests: number;
  retentionDays: number;
}
export interface AssistantConversation {
  id: string;
  createdAt: string;
  lastAt: string;
  lang: string;
  page: string;
  messages: number;
  firstQuestion: string;
}
export interface AssistantMessage {
  role: 'user' | 'assistant';
  source: 'faq' | 'llm' | 'fallback' | 'refusal' | null;
  faqId: string | null;
  text: string;
  at: string;
}
