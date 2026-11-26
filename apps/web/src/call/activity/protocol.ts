/**
 * Polls and Q&A over the LiveKit data channel (text streams, topic `davra.act`). Nothing is stored on the server: the state
 * lives in the participants' browsers for the length of the meeting (owner decision 10). In an end-to-end encrypted meeting
 * the data channel is encrypted with the meeting key like the media (see e2ee/provider.ts).
 *
 * Trust: the sender is the SFU-verified participant identity, never a payload field. Host-only messages (open/close a poll,
 * moderate a question, settings) are accepted only from senders whose server-set `role` attribute is host or cohost (join
 * tokens carry it and nobody may update their own attributes). Everything received is validated and size-limited here.
 */

export const ACT_TOPIC = 'davra.act';
export const MAX_POLLS = 50;
export const MAX_OPTIONS = 10;
export const MAX_QUESTIONS = 300;
export const POLL_Q_MAX = 300;
export const POLL_OPT_MAX = 120;
export const QA_TEXT_MAX = 500;
const ID_RE = /^[a-z0-9-]{6,40}$/;
const MAX_MSG = 256 * 1024;

export type Role = 'host' | 'cohost' | 'member' | 'guest';
export const isManagerRole = (r: string | undefined): boolean => r === 'host' || r === 'cohost';

export interface PollDef {
  id: string;
  q: string;
  options: string[];
  multi: boolean;
  anon: boolean;
}
export type QaOp = 'answered' | 'reopen' | 'hide' | 'unhide' | 'delete';

export interface PollSnap extends PollDef {
  open: boolean;
  by: string;
  ts: number;
  counts: number[];
  voters: number;
}
export interface QuestionSnap {
  id: string;
  text: string;
  /** Null for an anonymous question: no identity is ever kept for it. */
  author: string | null;
  authorName: string | null;
  ts: number;
  voters: string[];
  answered: boolean;
  hidden: boolean;
}

export type ActMsg =
  | { t: 'poll.open'; poll: PollDef }
  | { t: 'poll.close'; id: string }
  | { t: 'poll.vote'; id: string; choices: number[] }
  | { t: 'poll.tally'; id: string; counts: number[]; voters: number }
  | { t: 'qa.ask'; id: string; text: string; anon: boolean }
  | { t: 'qa.vote'; id: string; up: boolean }
  | { t: 'qa.mod'; id: string; op: QaOp }
  | { t: 'qa.cfg'; anon: boolean }
  | { t: 'snap'; polls: PollSnap[]; qa: QuestionSnap[]; anon: boolean };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** Trimmed text without control characters, or null when empty or too long. Newlines are kept only where allowed. */
export function cleanText(v: unknown, max: number, multiline = false): string | null {
  if (typeof v !== 'string') return null;
  let s = v.replace(CONTROL, '');
  if (!multiline) s = s.replace(/[\r\n\t]+/g, ' ');
  s = s.trim();
  if (!s || s.length > max) return null;
  return s;
}
const isId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100_000;

export function newId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return (c?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`).toLowerCase();
}

function parsePollDef(v: unknown): PollDef | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const q = cleanText(o.q, POLL_Q_MAX);
  if (!isId(o.id) || !q || !Array.isArray(o.options) || typeof o.multi !== 'boolean' || typeof o.anon !== 'boolean') return null;
  const options = o.options.map((x) => cleanText(x, POLL_OPT_MAX));
  if (options.length < 2 || options.length > MAX_OPTIONS || options.some((x) => x === null)) return null;
  return { id: o.id, q, options: options as string[], multi: o.multi, anon: o.anon };
}

function parseQuestionSnap(v: unknown): QuestionSnap | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const text = cleanText(o.text, QA_TEXT_MAX, true);
  if (!isId(o.id) || !text || !isCount(o.ts) || !Array.isArray(o.voters) || typeof o.answered !== 'boolean' || typeof o.hidden !== 'boolean') return null;
  const author = o.author === null ? null : typeof o.author === 'string' && o.author.length <= 80 ? o.author : undefined;
  const authorName = o.authorName === null ? null : cleanText(o.authorName, 120);
  if (author === undefined || (author !== null && !authorName)) return null;
  const voters = o.voters.filter((x): x is string => typeof x === 'string' && x.length <= 80).slice(0, 1000);
  return { id: o.id, text, author, authorName: author === null ? null : authorName, ts: o.ts, voters, answered: o.answered, hidden: o.hidden };
}

/** Decodes and validates one message; null for anything malformed, oversized or unknown. */
export function parseAct(text: string): ActMsg | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_MSG) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  switch (o.t) {
    case 'poll.open': {
      const poll = parsePollDef(o.poll);
      return poll ? { t: 'poll.open', poll } : null;
    }
    case 'poll.close':
      return isId(o.id) ? { t: 'poll.close', id: o.id } : null;
    case 'poll.vote': {
      if (!isId(o.id) || !Array.isArray(o.choices) || o.choices.length === 0 || o.choices.length > MAX_OPTIONS) return null;
      if (!o.choices.every((c) => Number.isInteger(c) && (c as number) >= 0 && (c as number) < MAX_OPTIONS)) return null;
      return { t: 'poll.vote', id: o.id, choices: Array.from(new Set(o.choices as number[])).sort((a, b) => a - b) };
    }
    case 'poll.tally':
      if (!isId(o.id) || !Array.isArray(o.counts) || o.counts.length > MAX_OPTIONS || !o.counts.every(isCount) || !isCount(o.voters)) return null;
      return { t: 'poll.tally', id: o.id, counts: o.counts as number[], voters: o.voters };
    case 'qa.ask': {
      const t = cleanText(o.text, QA_TEXT_MAX, true);
      return isId(o.id) && t && typeof o.anon === 'boolean' ? { t: 'qa.ask', id: o.id, text: t, anon: o.anon } : null;
    }
    case 'qa.vote':
      return isId(o.id) && typeof o.up === 'boolean' ? { t: 'qa.vote', id: o.id, up: o.up } : null;
    case 'qa.mod':
      return isId(o.id) && (o.op === 'answered' || o.op === 'reopen' || o.op === 'hide' || o.op === 'unhide' || o.op === 'delete') ? { t: 'qa.mod', id: o.id, op: o.op } : null;
    case 'qa.cfg':
      return typeof o.anon === 'boolean' ? { t: 'qa.cfg', anon: o.anon } : null;
    case 'snap': {
      if (!Array.isArray(o.polls) || !Array.isArray(o.qa) || typeof o.anon !== 'boolean') return null;
      const polls: PollSnap[] = [];
      for (const p of o.polls.slice(0, MAX_POLLS)) {
        const def = parsePollDef(p);
        const r = p as Record<string, unknown>;
        if (!def || typeof r.open !== 'boolean' || typeof r.by !== 'string' || r.by.length > 80 || !isCount(r.ts) || !Array.isArray(r.counts) || !r.counts.every(isCount) || r.counts.length !== def.options.length || !isCount(r.voters)) continue;
        polls.push({ ...def, open: r.open, by: r.by, ts: r.ts, counts: r.counts as number[], voters: r.voters });
      }
      const qa = o.qa.slice(0, MAX_QUESTIONS).map(parseQuestionSnap).filter((x): x is QuestionSnap => x !== null);
      return { t: 'snap', polls, qa, anon: o.anon };
    }
    default:
      return null;
  }
}

// ---- state ------------------------------------------------------------------------------------------------------------
export interface Poll extends PollSnap {
  /** Raw votes by voter identity: kept only by managers (they receive the votes); never shown for anonymous polls. */
  votes: Record<string, number[]>;
  /** What I chose (my own browser only). */
  mine: number[] | null;
}
export type Question = QuestionSnap;

export interface ActState {
  polls: Poll[];
  qa: Question[];
  /** Anonymous questions allowed (host setting, off by default). */
  anon: boolean;
}
export const EMPTY_ACT: ActState = { polls: [], qa: [], anon: false };

export interface Sender {
  id: string;
  name: string;
  role: string | undefined;
}

function tally(p: Poll): Poll {
  const counts = p.options.map(() => 0);
  const ballots = Object.values(p.votes);
  for (const b of ballots) for (const c of b) if (c < counts.length) counts[c]! += 1;
  return { ...p, counts, voters: ballots.length };
}

/**
 * Applies one received (or locally sent) message. Pure: returns the same object when the message changes nothing or is not
 * allowed for this sender. `now` is the receive time (used for ordering only).
 */
export function reduceAct(s: ActState, m: ActMsg, from: Sender, now: number): ActState {
  const manager = isManagerRole(from.role);
  switch (m.t) {
    case 'poll.open': {
      if (!manager || s.polls.some((p) => p.id === m.poll.id) || s.polls.length >= MAX_POLLS) return s;
      const poll: Poll = { ...m.poll, open: true, by: from.id, ts: now, counts: m.poll.options.map(() => 0), voters: 0, votes: {}, mine: null };
      return { ...s, polls: [...s.polls, poll] };
    }
    case 'poll.close': {
      if (!manager) return s;
      return { ...s, polls: s.polls.map((p) => (p.id === m.id ? { ...p, open: false } : p)) };
    }
    case 'poll.vote': {
      const p = s.polls.find((x) => x.id === m.id);
      if (!p || !p.open || p.votes[from.id]) return s; // one ballot per participant, no changes
      if (m.choices.some((c) => c >= p.options.length) || (!p.multi && m.choices.length !== 1)) return s;
      const next = tally({ ...p, votes: { ...p.votes, [from.id]: m.choices } });
      return { ...s, polls: s.polls.map((x) => (x.id === m.id ? next : x)) };
    }
    case 'poll.tally': {
      if (!manager) return s;
      const p = s.polls.find((x) => x.id === m.id);
      if (!p || m.counts.length !== p.options.length) return s;
      // A manager who holds the ballots trusts its own count; everyone else shows the lead manager's.
      if (Object.keys(p.votes).length > 0 && Object.keys(p.votes).length >= m.voters) return s;
      return { ...s, polls: s.polls.map((x) => (x.id === m.id ? { ...x, counts: m.counts, voters: m.voters } : x)) };
    }
    case 'qa.ask': {
      if (s.qa.some((q) => q.id === m.id) || s.qa.length >= MAX_QUESTIONS) return s;
      // An anonymous question is accepted only while the host allows it; otherwise it is shown with the sender's name.
      const anon = m.anon && s.anon;
      const q: Question = { id: m.id, text: m.text, author: anon ? null : from.id, authorName: anon ? null : from.name, ts: now, voters: [], answered: false, hidden: false };
      return { ...s, qa: [...s.qa, q] };
    }
    case 'qa.vote': {
      const q = s.qa.find((x) => x.id === m.id);
      if (!q) return s;
      const has = q.voters.includes(from.id);
      if (has === m.up) return s;
      const voters = m.up ? [...q.voters, from.id] : q.voters.filter((v) => v !== from.id);
      return { ...s, qa: s.qa.map((x) => (x.id === m.id ? { ...x, voters } : x)) };
    }
    case 'qa.mod': {
      if (!manager) return s;
      if (m.op === 'delete') return { ...s, qa: s.qa.filter((q) => q.id !== m.id) };
      const patch: Partial<Question> = m.op === 'answered' ? { answered: true } : m.op === 'reopen' ? { answered: false } : m.op === 'hide' ? { hidden: true } : { hidden: false };
      return { ...s, qa: s.qa.map((q) => (q.id === m.id ? { ...q, ...patch } : q)) };
    }
    case 'qa.cfg':
      return manager ? { ...s, anon: m.anon } : s;
    case 'snap': {
      if (!manager) return s;
      const polls = [...s.polls];
      for (const p of m.polls) {
        const i = polls.findIndex((x) => x.id === p.id);
        if (i < 0) polls.push({ ...p, votes: {}, mine: null });
        else if (Object.keys(polls[i]!.votes).length === 0) polls[i] = { ...polls[i]!, open: p.open, counts: p.counts, voters: p.voters };
      }
      const qa = [...s.qa];
      for (const q of m.qa) if (!qa.some((x) => x.id === q.id)) qa.push(q);
      qa.sort((a, b) => a.ts - b.ts);
      return { polls: polls.slice(0, MAX_POLLS), qa: qa.slice(0, MAX_QUESTIONS), anon: m.anon };
    }
  }
}

/** The snapshot a manager sends to someone who joins late (ballots are not included, only the counts). */
export function snapshot(s: ActState): Extract<ActMsg, { t: 'snap' }> {
  return {
    t: 'snap',
    polls: s.polls.map(({ votes: _v, mine: _m, ...p }) => p),
    qa: s.qa,
    anon: s.anon,
  };
}

/** The manager who answers late joiners and broadcasts poll counts: the present manager with the smallest identity. */
export function leadManager(present: Array<{ id: string; role: string | undefined }>): string | null {
  const ids = present.filter((p) => isManagerRole(p.role)).map((p) => p.id).sort();
  return ids[0] ?? null;
}

/** Questions as a participant sees them: hidden ones only for managers; sorted by votes or by time. */
export function visibleQuestions(qa: Question[], manager: boolean, sort: 'top' | 'new'): Question[] {
  const list = manager ? qa : qa.filter((q) => !q.hidden);
  return [...list].sort((a, b) => (sort === 'top' ? b.voters.length - a.voters.length || a.ts - b.ts : b.ts - a.ts));
}

// ---- CSV (host download during the meeting) --------------------------------------------------------------------------
/** One CSV cell; formula-looking text is prefixed with an apostrophe so spreadsheets never execute it (CSV injection). */
export function csvCell(v: string | number | boolean | null): string {
  let s = v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const row = (cells: Array<string | number | boolean | null>) => cells.map(csvCell).join(',');

export function pollsCsv(polls: Poll[], names: (id: string) => string): string {
  const out = [row(['poll', 'question', 'status', 'option', 'votes', 'voters_total'])];
  polls.forEach((p, i) => {
    p.options.forEach((o, k) => out.push(row([i + 1, p.q, p.open ? 'open' : 'closed', o, p.counts[k] ?? 0, p.voters])));
  });
  // Named ballots only for polls that were not anonymous, and only what this manager received.
  const named = polls.filter((p) => !p.anon && Object.keys(p.votes).length > 0);
  if (named.length) {
    out.push('');
    out.push(row(['poll', 'question', 'participant', 'choice']));
    named.forEach((p) => {
      const i = polls.indexOf(p) + 1;
      for (const [id, ch] of Object.entries(p.votes)) out.push(row([i, p.q, names(id), ch.map((c) => p.options[c] ?? '').join(' | ')]));
    });
  }
  return '﻿' + out.join('\r\n') + '\r\n';
}

export function qaCsv(qa: Question[], anonLabel: string): string {
  const out = [row(['question', 'asked_by', 'upvotes', 'answered', 'hidden', 'time'])];
  for (const q of [...qa].sort((a, b) => a.ts - b.ts)) {
    out.push(row([q.text, q.authorName ?? anonLabel, q.voters.length, q.answered, q.hidden, new Date(q.ts).toISOString()]));
  }
  return '﻿' + out.join('\r\n') + '\r\n';
}
