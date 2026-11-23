import { ApiError } from '../api';
import type { Key } from '../i18n';
import type { AuditFilters, Page } from './client';

/** Replaces `{name}`-style placeholders; unknown placeholders stay untouched. */
export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

export interface ErrorContext {
  /** Message key used for HTTP 409 in this operation (e.g. "department has users"). */
  conflict?: Key;
}

/** Maps an API failure to a user-facing message key. Never exposes server internals except 400 validation text. */
export function adminErrorKey(e: unknown, ctx: ErrorContext = {}): Key {
  if (e instanceof ApiError) {
    switch (e.status) {
      case 400:
        return 'admErrBadRequest';
      case 403:
        return 'admErrForbidden';
      case 404:
        return 'errNotFound';
      case 409:
        return ctx.conflict ?? 'admErrConflict';
      case 429:
        return 'errTooMany';
      case 503:
        return 'admErrUnavailable';
      default:
        return 'errGeneric';
    }
  }
  return 'errGeneric';
}

export function isForbidden(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403;
}

// ---- Policies -------------------------------------------------------------------------------------------------

export const MIN_PARTICIPANTS = 2;
export const MAX_PARTICIPANTS = 300;

/** Parses the max-participants field; returns null unless it is a whole number within 2..300. */
export function parseMaxParticipants(input: string): number | null {
  const s = input.trim();
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= MIN_PARTICIPANTS && n <= MAX_PARTICIPANTS ? n : null;
}

// ---- Audit filters --------------------------------------------------------------------------------------------

/** Converts a `datetime-local` value (local wall time) to an ISO-8601 UTC instant; empty or invalid -> undefined. */
export function localInputToIso(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value)) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface AuditForm {
  from: string;
  to: string;
  action: string;
  actor: string;
  target: string;
}

export const EMPTY_AUDIT_FORM: AuditForm = { from: '', to: '', action: '', actor: '', target: '' };

/** Turns the form into API filters; returns an error key when the range is inverted. */
export function toAuditFilters(form: AuditForm): { filters: AuditFilters; error: Key | null } {
  const from = localInputToIso(form.from);
  const to = localInputToIso(form.to);
  if (from && to && from > to) return { filters: {}, error: 'admErrRange' };
  const filters: AuditFilters = {};
  if (from) filters.from = from;
  if (to) filters.to = to;
  for (const k of ['action', 'actor', 'target'] as const) {
    const v = form[k].trim();
    if (v) filters[k] = v;
  }
  return { filters, error: null };
}

/** Locale-aware timestamp; falls back to the raw text when the value is not a date. */
export function formatTimestamp(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'medium' });
  } catch {
    return d.toLocaleString();
  }
}

// ---- Cursor pagination ----------------------------------------------------------------------------------------

export interface PagedState<T> {
  items: T[];
  next: string | null;
}

/** Appends a page (load more) or replaces the list (first page), skipping ids already shown. */
export function mergePage<T extends { id: string }>(prev: PagedState<T>, page: Page<T>, append: boolean): PagedState<T> {
  if (!append) return { items: [...page.items], next: page.next };
  const seen = new Set(prev.items.map((i) => i.id));
  return { items: [...prev.items, ...page.items.filter((i) => !seen.has(i.id))], next: page.next };
}

// ---- Temporary password lifecycle -----------------------------------------------------------------------------

/**
 * The temporary password exists only in the `shown` phase. Every other phase holds no secret, so leaving the phase
 * (dismiss, or any new creation flow) drops it. Nothing here touches storage.
 */
export type CreateFlow =
  | { phase: 'closed' }
  | { phase: 'form' }
  | { phase: 'shown'; email: string; temporaryPassword: string };

export type CreateFlowAction =
  | { type: 'open' }
  | { type: 'created'; email: string; temporaryPassword: string }
  | { type: 'dismiss' };

export function createFlowReducer(state: CreateFlow, action: CreateFlowAction): CreateFlow {
  switch (action.type) {
    case 'open':
      return { phase: 'form' };
    case 'created':
      return state.phase === 'form' ? { phase: 'shown', email: action.email, temporaryPassword: action.temporaryPassword } : state;
    case 'dismiss':
      return { phase: 'closed' };
  }
}

// ---- Sign-in return path --------------------------------------------------------------------------------------

const RETURN_KEY = 'postLoginPath';

export function isAdminPath(pathname: string): boolean {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

/** Remembers the admin path across the Keycloak redirect (which always returns to "/"). Only /admin is allowed. */
export function rememberReturnPath(pathname: string, store: Pick<Storage, 'setItem'> = sessionStorage): void {
  if (!isAdminPath(pathname)) return;
  try {
    store.setItem(RETURN_KEY, '/admin');
  } catch {
    /* storage unavailable */
  }
}

/** Returns and clears the remembered path (whitelisted to /admin), else null. */
export function consumeReturnPath(store: Pick<Storage, 'getItem' | 'removeItem'> = sessionStorage): string | null {
  try {
    const v = store.getItem(RETURN_KEY);
    store.removeItem(RETURN_KEY);
    return v === '/admin' ? v : null;
  } catch {
    return null;
  }
}
