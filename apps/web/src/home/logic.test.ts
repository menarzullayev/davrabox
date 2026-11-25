import { describe, expect, it } from 'vitest';
import type { Meeting } from '../api';
import { dictionaries } from '../i18n';
import {
  displayName,
  firstName,
  createdLabel,
  formatClock,
  formatCode,
  formatDay,
  greetingSlot,
  groupMeetings,
  joinLink,
  parseJoinInput,
  splitNames,
  timelineSize,
} from './logic';

describe('parseJoinInput', () => {
  it.each([
    ['12345678901', '12345678901'],
    ['123 4567 8901', '12345678901'],
    ['  123-4567-8901  ', '12345678901'],
    ['123456789012', '123456789012'],
  ])('accepts the code %j', (raw, code) => {
    expect(parseJoinInput(raw)).toEqual({ status: 'valid', code, fromLink: false });
  });

  it.each([
    ['https://davrabox.bugvector.uz/?join=12345678901', '12345678901'],
    ['http://192.168.1.5:8443/?join=123456789012&x=1', '123456789012'],
    ['https://example.test/join/12345678901', '12345678901'],
    ['https://example.test/join/12345678901/', '12345678901'],
    ['davrabox://join/12345678901', '12345678901'],
    ['davrabox.bugvector.uz/?join=12345678901', '12345678901'],
  ])('takes the code out of the link %j', (raw, code) => {
    expect(parseJoinInput(raw)).toEqual({ status: 'valid', code, fromLink: true });
  });

  it('reports empty and incomplete input without calling it an error', () => {
    expect(parseJoinInput('')).toEqual({ status: 'empty' });
    expect(parseJoinInput('   ')).toEqual({ status: 'empty' });
    expect(parseJoinInput('123 4567')).toEqual({ status: 'incomplete', digits: 7, missing: 4 });
    expect(parseJoinInput('1234567890')).toEqual({ status: 'incomplete', digits: 10, missing: 1 });
  });

  it('rejects clearly wrong input with a reason', () => {
    expect(parseJoinInput('1234567890123')).toEqual({ status: 'invalid', reason: 'tooLong' });
    expect(parseJoinInput('abc')).toEqual({ status: 'invalid', reason: 'notCode' });
    expect(parseJoinInput('123 4567 89a1')).toEqual({ status: 'invalid', reason: 'notCode' });
    expect(parseJoinInput('---')).toEqual({ status: 'invalid', reason: 'notCode' });
  });

  it('rejects links without a well-formed code', () => {
    expect(parseJoinInput('https://example.test/?join=123')).toEqual({ status: 'invalid', reason: 'noCodeInLink' });
    expect(parseJoinInput('https://example.test/')).toEqual({ status: 'invalid', reason: 'noCodeInLink' });
    expect(parseJoinInput('https://example.test/?join=1234567890123')).toEqual({ status: 'invalid', reason: 'noCodeInLink' });
    // a long number elsewhere in the URL is not a meeting code
    expect(parseJoinInput('https://example.test/?id=12345678901')).toEqual({ status: 'invalid', reason: 'noCodeInLink' });
  });
});

describe('formatCode and joinLink', () => {
  it('groups 3-4-rest, progressively', () => {
    expect(formatCode('12345678901')).toBe('123 4567 8901');
    expect(formatCode('123456789012')).toBe('123 4567 89012');
    expect(formatCode('1234')).toBe('123 4');
    expect(formatCode('')).toBe('');
  });
  it('builds the link the app understands (?join=) without a double slash', () => {
    expect(joinLink('https://davrabox.bugvector.uz/', '12345678901')).toBe('https://davrabox.bugvector.uz/app?join=12345678901');
    expect(parseJoinInput(joinLink('https://x.test', '12345678901'))).toMatchObject({ status: 'valid', code: '12345678901' });
  });
});

const NOW = new Date(2026, 10, 23, 14, 20); // Monday 23 November 2026, 14:20 local
const at = (dayOffset: number, h: number, m: number) => new Date(2026, 10, 23 + dayOffset, h, m).toISOString();
let n = 0;
const mk = (title: string, scheduled_at: string | null): Meeting => ({
  id: `id${++n}`,
  code: `3000000000${n}`.slice(0, 11),
  title,
  waiting_room: true,
  locked: false,
  scheduled_at,
  has_passcode: false,
});

describe('groupMeetings (injected clock)', () => {
  it('splits into now / later today / upcoming / recent / earlier and sorts each group', () => {
    const list = [
      mk('later b', at(0, 18, 0)),
      mk('earlier a', at(0, 9, 0)),
      mk('tomorrow', at(1, 10, 0)),
      mk('now', at(0, 14, 0)),
      mk('later a', at(0, 16, 0)),
      mk('unscheduled 1', null),
      mk('yesterday', at(-1, 10, 0)),
      mk('unscheduled 2', null),
    ];
    const g = groupMeetings(list, NOW);
    expect(g.now.map((m) => m.title)).toEqual(['now']);
    expect(g.later.map((m) => m.title)).toEqual(['later a', 'later b']);
    expect(g.upcoming.map((m) => m.title)).toEqual(['tomorrow']);
    expect(g.recent.map((m) => m.title)).toEqual(['unscheduled 1', 'unscheduled 2']);
    expect(g.earlier.map((m) => m.title)).toEqual(['earlier a', 'yesterday']);
    expect(timelineSize(g)).toBe(list.length);
  });

  it('puts the latest earlier meeting first', () => {
    const g = groupMeetings([mk('old', at(-3, 10, 0)), mk('recent', at(0, 9, 0)), mk('mid', at(-1, 10, 0))], NOW);
    expect(g.earlier.map((m) => m.title)).toEqual(['recent', 'mid', 'old']);
  });

  it('treats the hour after the start as "now" and not a minute longer', () => {
    expect(groupMeetings([mk('a', at(0, 13, 21))], NOW).now).toHaveLength(1);
    expect(groupMeetings([mk('a', at(0, 13, 20))], NOW).now).toHaveLength(0);
    expect(groupMeetings([mk('a', at(0, 13, 20))], NOW).earlier).toHaveLength(1);
    expect(groupMeetings([mk('a', at(0, 14, 20))], NOW).now).toHaveLength(1); // starts exactly now
  });

  it('a meeting a minute after the clock is "later", across midnight it is "upcoming"', () => {
    expect(groupMeetings([mk('a', at(0, 14, 21))], NOW).later).toHaveLength(1);
    const lateNow = new Date(2026, 10, 23, 23, 50);
    expect(groupMeetings([mk('a', at(1, 0, 10))], lateNow).upcoming).toHaveLength(1);
  });

  it('does not fail on a broken date and keeps the object fields', () => {
    const g = groupMeetings([mk('bad', 'not a date')], NOW);
    expect(g.recent[0]).toMatchObject({ title: 'bad', start: null });
  });
  it('is empty for no meetings', () => {
    expect(timelineSize(groupMeetings([], NOW))).toBe(0);
  });
});

describe('greeting and names', () => {
  it.each([
    [4, 'night'],
    [5, 'morning'],
    [10, 'morning'],
    [11, 'day'],
    [16, 'day'],
    [17, 'evening'],
    [22, 'evening'],
    [23, 'night'],
    [0, 'night'],
  ])('hour %i is %s', (h, slot) => {
    expect(greetingSlot(new Date(2026, 10, 23, h, 30))).toBe(slot);
  });

  it('extracts the first name from the profile, in order of preference', () => {
    expect(firstName({ given_name: 'Alisher', name: 'Bobur Karimov' })).toBe('Alisher');
    expect(firstName({ name: '  Nilufar  Karimova ' })).toBe('Nilufar');
    expect(firstName({ name: 'O‘ktam Aliyev' })).toBe('O‘ktam');
    expect(firstName({ email: 'alice.admin@acme.test' })).toBe('Alice');
    expect(firstName({ preferred_username: 'bob_member' })).toBe('Bob');
    expect(firstName({})).toBe('');
    expect(firstName(undefined)).toBe('');
    expect(firstName({ name: 42 as unknown as string, email: '1234@x.test' })).toBe('');
  });

  it('shows the full display name for the account chip', () => {
    expect(displayName({ name: 'Alisher Narzullayev', email: 'a@x.test' })).toBe('Alisher Narzullayev');
    expect(displayName({ email: 'a@x.test' })).toBe('a@x.test');
    expect(displayName(undefined)).toBe('');
  });
});

describe('time and date formatting in uz / ru / en', () => {
  it('formats the clock as HH:mm, zero padded', () => {
    expect(formatClock(new Date(2026, 10, 23, 9, 5))).toBe('09:05');
    expect(formatClock(new Date(2026, 10, 23, 0, 0))).toBe('00:00');
    expect(formatClock(new Date(2026, 10, 23, 23, 59))).toBe('23:59');
  });

  const day = (lang: 'uz' | 'ru' | 'en') => {
    const d = dictionaries[lang];
    return { weekdays: splitNames(d.hWeekdays), months: splitNames(d.hMonths), template: d.hDayFormat };
  };
  it.each([
    ['uz', 'dushanba, 23-noyabr'],
    ['ru', 'понедельник, 23 ноября'],
    ['en', 'Monday, 23 November'],
  ] as const)('formats Monday 23 November in %s', (lang, text) => {
    expect(formatDay(NOW, day(lang))).toBe(text);
  });

  it('every language lists 7 weekdays and 12 months', () => {
    for (const lang of ['uz', 'ru', 'en'] as const) {
      expect(day(lang).weekdays).toHaveLength(7);
      expect(day(lang).months).toHaveLength(12);
    }
  });
});

describe('created_at on unscheduled meetings', () => {
  const MONTHS = splitNames('January,February,March,April,May,June,July,August,September,October,November,December');
  const made = (iso: string) => new Date(iso);
  it('says "just now" under a minute, tolerating a little clock skew', () => {
    expect(createdLabel(new Date(NOW.getTime() - 59_000), NOW, MONTHS)).toEqual({ key: 'hCreatedJustNow' });
    expect(createdLabel(new Date(NOW.getTime() + 2 * 60_000), NOW, MONTHS)).toEqual({ key: 'hCreatedJustNow' });
  });
  it('shows only the time on the same day and the date on another day', () => {
    expect(createdLabel(new Date(2026, 10, 23, 9, 5), NOW, MONTHS)).toEqual({ key: 'hCreatedAt', vars: { time: '09:05' } });
    expect(createdLabel(new Date(2026, 10, 21, 15, 24), NOW, MONTHS)).toEqual({ key: 'hCreatedOn', vars: { day: 21, month: 'November', time: '15:24' } });
  });
  it('has no label without a date', () => {
    expect(createdLabel(null, NOW, MONTHS)).toBeNull();
    expect(groupMeetings([{ ...mk('x', null), created_at: 'garbage' }], NOW).recent[0]?.created).toBeNull();
  });
  it('lists unscheduled meetings newest created first and keeps API order without created_at', () => {
    const a = { ...mk('a', null), created_at: made('2026-11-20T10:00:00Z').toISOString() };
    const b = { ...mk('b', null), created_at: made('2026-11-22T10:00:00Z').toISOString() };
    expect(groupMeetings([a, b], NOW).recent.map((m) => m.title)).toEqual(['b', 'a']);
    expect(groupMeetings([mk('p', null), mk('q', null)], NOW).recent.map((m) => m.title)).toEqual(['p', 'q']);
  });
});
