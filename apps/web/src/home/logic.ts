// Pure logic of the home screens (no React, no DOM): join-code parsing and validation, grouping meetings on a day
// timeline with an injected clock, greeting and name extraction, time/date formatting driven by the dictionaries.
import type { Meeting } from '../api';

/** A meeting code is 11 or 12 digits (the same rule the sign-in redirect uses for ?join=). */
export const CODE_RE = /^[0-9]{11,12}$/;
export const CODE_MIN = 11;
export const CODE_MAX = 12;

export type JoinInvalidReason = 'notCode' | 'tooLong' | 'noCodeInLink';
export type JoinParse =
  | { status: 'empty' }
  | { status: 'incomplete'; digits: number; missing: number }
  | { status: 'valid'; code: string; fromLink: boolean }
  | { status: 'invalid'; reason: JoinInvalidReason };

/** "12345678901" -> "123 4567 8901" (progressive: also formats partial input). */
export function formatCode(code: string): string {
  const d = code.replace(/\D/g, '');
  return [d.slice(0, 3), d.slice(3, 7), d.slice(7)].filter(Boolean).join(' ');
}

const DIGITS_ONLY = /^[\d\s.-]+$/;
const LINK_HINT = /[:/?#]|\.[A-Za-z]/;

/**
 * Understands what people paste into the join field: `12345678901`, `123 4567 8901`, `123-4567-8901`, a meeting
 * link (`https://host/?join=12345678901`, `https://host/join/12345678901`) or the desktop deep link
 * (`davrabox://join/12345678901`). Anything else is reported with a reason the UI can explain.
 */
export function parseJoinInput(raw: string): JoinParse {
  const s = raw.trim();
  if (!s) return { status: 'empty' };
  if (DIGITS_ONLY.test(s)) {
    const digits = s.replace(/\D/g, '');
    if (digits.length === 0) return { status: 'invalid', reason: 'notCode' };
    if (digits.length > CODE_MAX) return { status: 'invalid', reason: 'tooLong' };
    if (digits.length < CODE_MIN) return { status: 'incomplete', digits: digits.length, missing: CODE_MIN - digits.length };
    return { status: 'valid', code: digits, fromLink: false };
  }
  if (LINK_HINT.test(s)) {
    const m = /[?&#]join=(\d{11,12})(?!\d)/.exec(s) ?? /\/(\d{11,12})(?=$|[/?#])/.exec(s);
    if (m?.[1]) return { status: 'valid', code: m[1], fromLink: true };
    return { status: 'invalid', reason: 'noCodeInLink' };
  }
  return { status: 'invalid', reason: 'notCode' };
}

/** Link that opens the application with the join field pre-filled (handled by App through ?join=; the app lives at /app). */
export function joinLink(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, '')}/app?join=${encodeURIComponent(code)}`;
}

// ---- day timeline -------------------------------------------------------------------------------------------

export interface TimelineMeeting extends Meeting {
  /** Parsed scheduled_at, null when the meeting is not scheduled (or the value is not a date). */
  start: Date | null;
  /** Parsed created_at, null when the API did not send it (or the value is not a date). */
  created: Date | null;
}

export interface Timeline {
  now: TimelineMeeting[];
  later: TimelineMeeting[];
  upcoming: TimelineMeeting[];
  recent: TimelineMeeting[];
  earlier: TimelineMeeting[];
}

export type TimelineGroup = keyof Timeline;
export const GROUP_ORDER: readonly TimelineGroup[] = ['now', 'later', 'upcoming', 'recent', 'earlier'];

/** A meeting counts as "now" from its start until this long after it (the API has no end time). */
export const NOW_WINDOW_MIN = 60;

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function parseStart(v: string | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Groups meetings for the home timeline. `now` is injected so the result is deterministic.
 *  - now: started within the last hour; later: starts later today; upcoming: starts on a later day;
 *  - earlier: started more than an hour ago (latest first); recent: not scheduled (newest created first; the order
 *    the API gave is kept for meetings without created_at).
 */
export function groupMeetings(meetings: readonly Meeting[], now: Date, windowMin = NOW_WINDOW_MIN): Timeline {
  const out: Timeline = { now: [], later: [], upcoming: [], recent: [], earlier: [] };
  const windowMs = windowMin * 60_000;
  for (const m of meetings) {
    const start = parseStart(m.scheduled_at);
    const row: TimelineMeeting = { ...m, start, created: parseStart(m.created_at ?? null) };
    if (!start) out.recent.push(row);
    else if (start.getTime() > now.getTime()) (sameDay(start, now) ? out.later : out.upcoming).push(row);
    else if (now.getTime() - start.getTime() < windowMs) out.now.push(row);
    else out.earlier.push(row);
  }
  const byStart = (a: TimelineMeeting, b: TimelineMeeting) => a.start!.getTime() - b.start!.getTime();
  out.now.sort(byStart);
  out.later.sort(byStart);
  out.upcoming.sort(byStart);
  out.earlier.sort((a, b) => byStart(b, a));
  out.recent.sort((a, b) => (b.created?.getTime() ?? 0) - (a.created?.getTime() ?? 0)); // stable: no created_at keeps API order
  return out;
}

export type CreatedLabel =
  | { key: 'hCreatedJustNow' }
  | { key: 'hCreatedAt'; vars: { time: string } }
  | { key: 'hCreatedOn'; vars: { day: number; month: string; time: string } };

/**
 * "Created just now / Created 15:24 / Created 21 November, 15:24" for a meeting without a schedule. Under a minute
 * (a small clock skew into the future counts too) is "just now"; the same calendar day shows the time only.
 */
export function createdLabel(created: Date | null, now: Date, monthNames: readonly string[]): CreatedLabel | null {
  if (!created) return null;
  const age = now.getTime() - created.getTime();
  if (age < 60_000 && age > -5 * 60_000) return { key: 'hCreatedJustNow' };
  const time = formatClock(created);
  if (sameDay(created, now)) return { key: 'hCreatedAt', vars: { time } };
  return { key: 'hCreatedOn', vars: { day: created.getDate(), month: monthNames[created.getMonth()] ?? '', time } };
}

export type MeetingTab = 'ongoing' | 'upcoming' | 'ended';
export const TAB_ORDER: readonly MeetingTab[] = ['ongoing', 'upcoming', 'ended'];
/**
 * Which timeline groups each tab shows. Meetings without a schedule can be joined at any time, so they sit under
 * Ongoing with the ones that are running now.
 */
export const TAB_GROUPS: Record<MeetingTab, readonly TimelineGroup[]> = {
  ongoing: ['now', 'recent'],
  upcoming: ['later', 'upcoming'],
  ended: ['earlier'],
};

export const tabSize = (t: Timeline, tab: MeetingTab): number => TAB_GROUPS[tab].reduce((n, g) => n + t[g].length, 0);

/** The tab opened first: the first one that has meetings, Ongoing when there are none at all. */
export function defaultTab(t: Timeline): MeetingTab {
  return TAB_ORDER.find((tab) => tabSize(t, tab) > 0) ?? 'ongoing';
}

export const timelineSize = (t: Timeline): number => GROUP_ORDER.reduce((n, g) => n + t[g].length, 0);

// ---- greeting and names ------------------------------------------------------------------------------------

export type GreetingSlot = 'morning' | 'day' | 'evening' | 'night';

export function greetingSlot(now: Date): GreetingSlot {
  const h = now.getHours();
  if (h >= 5 && h < 11) return 'morning';
  if (h >= 11 && h < 17) return 'day';
  if (h >= 17 && h < 23) return 'evening';
  return 'night';
}

export interface ProfileLike {
  given_name?: unknown;
  name?: unknown;
  preferred_username?: unknown;
  email?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const capitalize = (w: string) => (w ? w.charAt(0).toLocaleUpperCase() + w.slice(1) : w);

/** First name for the greeting: given_name, else the first word of the name, else the e-mail local part; "" if none. */
export function firstName(p: ProfileLike | undefined | null): string {
  if (!p) return '';
  const given = str(p.given_name).split(/\s+/)[0];
  if (given) return given;
  const full = str(p.name).split(/\s+/)[0];
  if (full) return full;
  for (const src of [str(p.preferred_username), str(p.email).split('@')[0] ?? '']) {
    const w = src.split(/[._\-+\s]+/)[0];
    if (w && /\p{L}/u.test(w)) return capitalize(w);
  }
  return '';
}

/** Full display name for the account chip. */
export function displayName(p: ProfileLike | undefined | null): string {
  if (!p) return '';
  return str(p.name) || str(p.preferred_username) || str(p.email);
}

// ---- time and date formatting ------------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 24-hour clock "09:05", the same in every language (tabular, unambiguous, what the product uses everywhere). */
export function formatClock(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export interface DayNames {
  /** Seven names starting with Sunday (Date#getDay order). */
  weekdays: readonly string[];
  /** Twelve names starting with January, already in the case the template needs. */
  months: readonly string[];
  /** Template with {weekday}, {day}, {month}. */
  template: string;
}

/** Splits a dictionary list entry ("a,b,c") into trimmed names. */
export const splitNames = (s: string): string[] => s.split(',').map((x) => x.trim());

export function formatDay(d: Date, names: DayNames): string {
  return names.template
    .replace('{weekday}', names.weekdays[d.getDay()] ?? '')
    .replace('{day}', String(d.getDate()))
    .replace('{month}', names.months[d.getMonth()] ?? '');
}

export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

// ---- plan and limits ---------------------------------------------------------------------------------------

export interface PlanSummary {
  /** Whole days left, rounded up (a trial with 5 h left shows 1); 0 once it is over. */
  daysLeft: number;
  expired: boolean;
  maxParticipants: number | null;
  maxMinutes: number | null;
}

/** What the "Plan & Limits" card shows for a trial organization; null for a paid one (nothing to show) or bad data. */
export function planSummary(
  s: { trial: boolean; endsAt: string | null; maxParticipants: number | null; maxMinutes: number | null } | null | undefined,
  now: Date,
): PlanSummary | null {
  if (!s || !s.trial || !s.endsAt) return null;
  const end = Date.parse(s.endsAt);
  if (!Number.isFinite(end)) return null;
  const left = end - now.getTime();
  return { daysLeft: left > 0 ? Math.ceil(left / 86_400_000) : 0, expired: left <= 0, maxParticipants: s.maxParticipants, maxMinutes: s.maxMinutes };
}
