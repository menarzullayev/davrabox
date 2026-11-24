import { ApiError } from '../api';
import type { Key } from '../i18n';

/** What the server writes into an erased account (apps/api/src/privacy/privacy.service.ts). */
export const ERASED_EMAIL = 'erased@erased.invalid';

export function isErased(u: { email: string }): boolean {
  return u.email === ERASED_EMAIL;
}

/** The typed confirmation of an erasure: the account's e-mail address, case and surrounding spaces ignored, never empty. */
export function confirmMatches(typed: string, email: string): boolean {
  const a = typed.trim().toLowerCase();
  return a !== '' && a === email.trim().toLowerCase();
}

/** Message for a failed export or erasure. 409 = last admin or a recording still running; 502/503 = the request is saved and is finished by the server. */
export function privacyErrorKey(e: unknown): Key {
  if (e instanceof ApiError) {
    switch (e.status) {
      case 400:
        return 'admPrivErrMismatch';
      case 403:
        return 'admErrForbidden';
      case 404:
        return 'errNotFound';
      case 409:
        return 'admPrivErrConflict';
      case 410:
        return 'admPrivErrGone';
      case 429:
        return 'errTooMany';
      case 502:
      case 503:
        return 'admPrivErrUpstream';
      default:
        return 'errGeneric';
    }
  }
  return 'errGeneric';
}
