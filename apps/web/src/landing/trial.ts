import type { Key } from '../i18n';

const DAY = 86_400_000;

export interface TrialBanner {
  key: Key;
  n?: number;
}

/**
 * The "trial ends soon" notice of the application home: a soft reminder in the last 2 days (owner decision 5 of 2026-11-27), with its own wording for the
 * last day. Nothing for a paid organization (no end date), a distant end, or a trial that is already over (the server
 * answers 402 for those and the application shows that error instead).
 */
export function trialBanner(endsAt: string | null, now: number): TrialBanner | null {
  if (!endsAt) return null;
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return null;
  const left = end - now;
  if (left <= 0 || left > 2 * DAY) return null;
  if (left <= DAY) return { key: 'lnTrialEndsToday' };
  return { key: 'lnTrialEnds', n: Math.ceil(left / DAY) };
}
