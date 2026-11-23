import { ApiError } from '../api';
import type { Key } from '../i18n';
import { adminErrorKey } from './helpers';

export const API_KEY_SCOPES = ['meetings:read', 'meetings:write', 'users:read'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
export const WEBHOOK_EVENTS = ['meeting.created', 'meeting.ended', 'participant.joined', 'participant.left'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export type DeliveryStatus = 'pending' | 'delivered' | 'dead';

const SCOPE_LABEL: Record<ApiKeyScope, Key> = {
  'meetings:read': 'admIntScopeMeetingsRead',
  'meetings:write': 'admIntScopeMeetingsWrite',
  'users:read': 'admIntScopeUsersRead',
};
const EVENT_LABEL: Record<WebhookEvent, Key> = {
  'meeting.created': 'admIntHookEventCreated',
  'meeting.ended': 'admIntHookEventEnded',
  'participant.joined': 'admIntHookEventJoined',
  'participant.left': 'admIntHookEventLeft',
};
const STATUS_LABEL: Record<DeliveryStatus, Key> = {
  pending: 'admIntDelStatusPending',
  delivered: 'admIntDelStatusDelivered',
  dead: 'admIntDelStatusDead',
};

export const scopeLabelKey = (s: ApiKeyScope): Key => SCOPE_LABEL[s];
export const eventLabelKey = (e: WebhookEvent): Key => EVENT_LABEL[e];
export const deliveryStatusKey = (s: DeliveryStatus): Key => STATUS_LABEL[s];

/** Adds or removes `value`, keeping the canonical order of `order` so the request body is stable. */
export function toggleOrdered<T extends string>(list: readonly T[], value: T, order: readonly T[]): T[] {
  const next = new Set(list);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return order.filter((x) => next.has(x));
}

export function validateKeyForm(f: { name: string; scopes: readonly ApiKeyScope[] }): Key | null {
  if (!f.name.trim()) return 'admErrBadRequest';
  if (f.scopes.length === 0) return 'admIntNeedScope';
  return null;
}

/** First-line check only: the server resolves the host and refuses private and reserved targets. */
export function validateHookForm(f: { url: string; events: readonly WebhookEvent[] }): Key | null {
  if (!/^https:\/\/\S+$/.test(f.url.trim())) return 'admIntUrlHttps';
  if (f.events.length === 0) return 'admIntNeedEvent';
  return null;
}

/** Maps an API failure to a message key; never shows server text (it can name internal addresses). */
export function integrationErrorKey(e: unknown, kind: 'key' | 'hook'): Key {
  if (e instanceof ApiError) {
    if (e.status === 409) return kind === 'key' ? 'admIntKeyTooMany' : 'admIntHookTooMany';
    if (e.status === 400 && kind === 'hook') return 'admIntUrlRejected';
    if (e.status === 503 && kind === 'hook') return 'admIntHookNotConfigured';
  }
  return adminErrorKey(e);
}
