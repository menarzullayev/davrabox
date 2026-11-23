// Pure helpers of the "Add to calendar" feature (no DOM, no network).

export type CalProvider = 'google' | 'microsoft';
export const CAL_PROVIDERS: readonly CalProvider[] = ['google', 'microsoft'];

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
export const MAX_ATTENDEES = 50;
export const MIN_MINUTES = 5;
export const MAX_MINUTES = 12 * 60;

/** Splits free text into addresses (commas, semicolons, whitespace), removing duplicates ignoring case. */
export function parseAttendees(text: string): { emails: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const emails: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const v = raw.trim();
    if (!v) continue;
    if (!EMAIL_RE.test(v)) {
      invalid.push(v);
      continue;
    }
    const k = v.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    emails.push(v);
  }
  return { emails, invalid };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Value for <input type="datetime-local"> in the viewer's own time zone. */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Parses a datetime-local value; null when empty or not a real date. */
export function fromLocalInput(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const [y, mo, da, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const d = new Date(y, mo - 1, da, h, mi);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da || d.getHours() !== h || d.getMinutes() !== mi) return null;
  return d;
}

/** The meeting's scheduled time when it is still ahead, otherwise the next half hour. */
export function defaultStart(scheduledAt: string | null | undefined, now: Date): Date {
  if (scheduledAt) {
    const s = new Date(scheduledAt);
    if (!Number.isNaN(s.getTime()) && s.getTime() > now.getTime()) return s;
  }
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return d;
}

export interface EventBody {
  provider: CalProvider;
  start: string;
  end: string;
  attendees?: string[];
}

export function buildEventBody(
  provider: CalProvider,
  startLocal: string,
  minutes: number,
  attendeesText: string,
): { ok: true; body: EventBody } | { ok: false; error: 'calBadTime' | 'calBadAttendees' } {
  const start = fromLocalInput(startLocal);
  if (!start || !Number.isFinite(minutes) || minutes < MIN_MINUTES || minutes > MAX_MINUTES) return { ok: false, error: 'calBadTime' };
  const { emails, invalid } = parseAttendees(attendeesText);
  if (invalid.length > 0 || emails.length > MAX_ATTENDEES) return { ok: false, error: 'calBadAttendees' };
  const end = new Date(start.getTime() + minutes * 60_000);
  const body: EventBody = { provider, start: start.toISOString(), end: end.toISOString() };
  if (emails.length) body.attendees = emails;
  return { ok: true, body };
}

export type CalErrorKey = 'calNotConfigured' | 'calHostOnly' | 'calReconnect' | 'calBadInput' | 'calTooMany' | 'calFailed';

export function calendarErrorKey(status: number): CalErrorKey {
  switch (status) {
    case 503:
      return 'calNotConfigured';
    case 403:
      return 'calHostOnly';
    case 409:
      return 'calReconnect';
    case 400:
      return 'calBadInput';
    case 429:
      return 'calTooMany';
    default:
      return 'calFailed';
  }
}

export interface ReturnNotice {
  kind: 'connected' | 'denied' | 'error';
  provider: CalProvider;
}

/** What the API's OAuth callback redirected back with (`?calendar=connected&provider=google`). Unknown values are ignored. */
export function returnNotice(search: string): ReturnNotice | null {
  const p = new URLSearchParams(search);
  const kind = p.get('calendar');
  const provider = p.get('provider');
  if (kind !== 'connected' && kind !== 'denied' && kind !== 'error') return null;
  if (provider !== 'google' && provider !== 'microsoft') return null;
  return { kind, provider };
}

export function stripReturnParams(search: string): string {
  const p = new URLSearchParams(search);
  p.delete('calendar');
  p.delete('provider');
  const s = p.toString();
  return s ? `?${s}` : '';
}
