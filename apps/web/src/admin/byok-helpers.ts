import { ApiError } from '../api';
import type { Key } from '../i18n';
import type { RewrapResult } from './client';

export interface KmsForm {
  addr: string;
  token: string;
  keyName: string;
  mount: string;
  namespace: string;
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Mount paths are a few safe segments joined by single slashes; checked segment by segment (linear, no backtracking). */
function mountOk(m: string): boolean {
  const parts = m.split('/');
  return parts.length <= 4 && parts.every((p) => NAME_RE.test(p));
}

/** Client-side hints only: the server validates again and decides what addresses are allowed. */
export function validateKmsForm(f: KmsForm): Key | null {
  let u: URL | null = null;
  try {
    u = new URL(f.addr.trim());
  } catch {
    u = null;
  }
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return 'admEncNeedAddr';
  if (!f.token) return 'admEncNeedToken';
  if (!NAME_RE.test(f.keyName.trim())) return 'admEncNeedKey';
  if (!mountOk(f.mount.trim())) return 'admEncNeedMount';
  return null;
}

/** Maps an API failure to a message key. Server text is never shown: it can name internal addresses. */
export function kmsErrorKey(e: unknown, op: 'put' | 'remove' | 'other' = 'other'): Key {
  if (e instanceof ApiError) {
    switch (e.status) {
      case 400:
        return 'admEncErrAddr';
      case 404:
        return 'admEncErrNotConfigured';
      case 409:
        return op === 'remove' ? 'admEncRemoveBlocked' : 'admEncErrWrapped';
      case 422:
        return 'admEncErrUnusable';
      case 423:
        return 'admEncErrDenied';
      case 429:
        return 'errTooMany';
      case 503:
        return /not configured/i.test(e.detail) ? 'admEncErrNoKms' : 'admEncErrUnreachable';
      default:
        return 'errGeneric';
    }
  }
  return 'errGeneric';
}

export function kmsStatusKey(s: string): Key {
  switch (s) {
    case 'ok':
      return 'admEncStatusOk';
    case 'denied':
      return 'admEncStatusDenied';
    case 'unreachable':
      return 'admEncStatusUnreachable';
    default:
      return 'admEncStatusUnknown';
  }
}

export function kmsStatusTone(s: string): 'success' | 'danger' | 'neutral' {
  return s === 'ok' ? 'success' : s === 'denied' || s === 'unreachable' ? 'danger' : 'neutral';
}

type RewrapCall = (b: { target: 'customer' | 'platform'; limit: number; after?: string }) => Promise<RewrapResult>;

/**
 * Drives the resumable re-wrap: calls the server batch by batch with the cursor it returns until it reports it is done.
 * A failure stops the loop and is thrown (objects already moved stay moved; pressing the button again continues).
 */
export async function rewrapAll(call: RewrapCall, target: 'customer' | 'platform', onProgress: (moved: number) => void): Promise<{ processed: number; failed: number; remaining: number }> {
  let after: string | undefined;
  let processed = 0;
  let failed = 0;
  let remaining = 0;
  const seen = new Set<string>();
  for (let i = 0; i < 100_000; i++) {
    const r = await call({ target, limit: 100, after });
    processed += r.processed;
    failed += r.failed;
    remaining = r.remaining;
    onProgress(processed);
    if (!r.next) return { processed, failed, remaining };
    if (seen.has(r.next)) throw new Error('the server repeated a cursor');
    seen.add(r.next);
    after = r.next;
  }
  throw new Error('too many batches');
}
