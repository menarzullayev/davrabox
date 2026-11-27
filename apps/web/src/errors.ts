import { ApiError } from './api';
import type { Key } from './i18n';

/** Message key for a failed join or create call (shown on the home screen). */
export function appErrorKey(e: unknown): Key {
  if (e instanceof ApiError) {
    if (e.status === 410 || e.code === 'cancelled') return 'errCancelled';
    if (e.code === 'country_blocked') return 'errCountryBlocked';
    if (e.code === 'passcode_required') return 'errPasscodeRequired';
    if (e.status === 404) return 'errNotFound';
    if (e.status === 429) return 'errTooMany';
    if (e.status === 402) return 'lnErrTrialExpired'; // the organization's free trial is over
    if (e.status === 403) {
      if (/passcode/i.test(e.detail)) return 'errWrongPasscode';
      if (/locked/i.test(e.detail)) return 'errLocked';
      if (/removed/i.test(e.detail)) return 'errRemoved';
      if (/declined/i.test(e.detail)) return 'errDenied';
      if (/full/i.test(e.detail)) return 'lnErrFull';
    }
  }
  return 'errGeneric';
}
