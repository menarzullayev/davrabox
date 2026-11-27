// The person's display choices from the profile (owner decision 2): time zone, date and time format. Defaults come from the
// browser (null = the device's own zone, the product's 24-hour clock and the language's date order). One small store, read by
// the formatting helpers, so every screen shows times the same way.
export interface DisplayChoices {
  timeZone: string | null;
  dateFormat: 'dmy' | 'mdy' | 'ymd' | null;
  timeFormat: '24h' | '12h' | null;
}

let current: DisplayChoices = { timeZone: null, dateFormat: null, timeFormat: null };
const listeners = new Set<() => void>();

export function setDisplay(d: Partial<DisplayChoices>): void {
  current = { ...current, ...d };
  for (const l of listeners) l();
}
export function getDisplay(): DisplayChoices {
  return current;
}
export function onDisplay(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The browser's own zone (the default the profile offers). */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function parts(d: Date, d2: DisplayChoices): Record<string, string> {
  const f = new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    ...(d2.timeZone ? { timeZone: d2.timeZone } : {}),
  });
  const out: Record<string, string> = {};
  for (const p of f.formatToParts(d)) out[p.type] = p.value;
  return out;
}

/** "09:05" (24 h, the default) or "9:05 AM" (12 h), in the chosen zone. */
export function clock(d: Date, c: DisplayChoices = current): string {
  const p = parts(d, c);
  const h = Number(p['hour']);
  if (c.timeFormat === '12h') return `${h % 12 || 12}:${p['minute']} ${h < 12 ? 'AM' : 'PM'}`;
  return `${p['hour']}:${p['minute']}`;
}

/** "27.11.2026", "11/27/2026" or "2026-11-27"; null format = the language's own medium date. */
export function dateText(d: Date, lang: string, c: DisplayChoices = current): string {
  if (!c.dateFormat) {
    try {
      return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', year: 'numeric', ...(c.timeZone ? { timeZone: c.timeZone } : {}) }).format(d);
    } catch {
      return d.toISOString().slice(0, 10);
    }
  }
  const p = parts(d, c);
  if (c.dateFormat === 'dmy') return `${p['day']}.${p['month']}.${p['year']}`;
  if (c.dateFormat === 'mdy') return `${p['month']}/${p['day']}/${p['year']}`;
  return `${p['year']}-${p['month']}-${p['day']}`;
}

export function dateTimeText(d: Date, lang: string, c: DisplayChoices = current): string {
  return `${dateText(d, lang, c)}, ${clock(d, c)}`;
}
