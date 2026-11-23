import { describe, expect, it } from 'vitest';
import { buildEventBody, calendarErrorKey, defaultStart, fromLocalInput, parseAttendees, returnNotice, stripReturnParams, toLocalInput } from './logic';

describe('parseAttendees', () => {
  it('splits on commas, semicolons and whitespace, trims and de-duplicates ignoring case', () => {
    expect(parseAttendees('a@x.com, B@y.org;a@X.com\n c@z.uz ')).toEqual({ emails: ['a@x.com', 'B@y.org', 'c@z.uz'], invalid: [] });
  });
  it('reports what is not an email and keeps the valid ones', () => {
    expect(parseAttendees('a@x.com nobody foo@bar')).toEqual({ emails: ['a@x.com'], invalid: ['nobody', 'foo@bar'] });
  });
  it('empty text is no attendees', () => {
    expect(parseAttendees('  ')).toEqual({ emails: [], invalid: [] });
  });
  it('more than 50 addresses are all reported as emails (the server enforces the cap) but the builder refuses them', () => {
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@x.com`).join(',');
    const r = buildEventBody('google', '2026-12-01T10:00', 60, many);
    expect(r).toEqual({ ok: false, error: 'calBadAttendees' });
  });
});

describe('local datetime helpers', () => {
  it('round-trips a local value', () => {
    const d = fromLocalInput('2026-12-01T09:30')!;
    expect(toLocalInput(d)).toBe('2026-12-01T09:30');
  });
  it('rejects empty and malformed values', () => {
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('tomorrow')).toBeNull();
    expect(fromLocalInput('2026-13-45T99:99')).toBeNull();
  });
});

describe('defaultStart', () => {
  const now = new Date(2026, 10, 24, 10, 12);
  it('uses the scheduled time when it is still ahead', () => {
    const sched = new Date(2026, 10, 25, 15, 0).toISOString();
    expect(defaultStart(sched, now).getTime()).toBe(new Date(2026, 10, 25, 15, 0).getTime());
  });
  it('otherwise the next half hour', () => {
    expect(toLocalInput(defaultStart(null, now))).toBe('2026-11-24T10:30');
    expect(toLocalInput(defaultStart(new Date(2026, 10, 1).toISOString(), now))).toBe('2026-11-24T10:30');
    expect(toLocalInput(defaultStart(null, new Date(2026, 10, 24, 10, 30)))).toBe('2026-11-24T11:00');
  });
});

describe('buildEventBody', () => {
  it('builds UTC instants the server accepts (offset present) and omits attendees when none', () => {
    const r = buildEventBody('google', '2026-12-01T10:00', 90, '');
    if (!r.ok) throw new Error('expected ok');
    expect(r.body.provider).toBe('google');
    expect(r.body.start).toMatch(/Z$/);
    expect(Date.parse(r.body.end) - Date.parse(r.body.start)).toBe(90 * 60_000);
    expect('attendees' in r.body).toBe(false);
  });
  it('passes valid attendees and refuses invalid ones', () => {
    const ok = buildEventBody('microsoft', '2026-12-01T10:00', 30, 'a@x.com');
    expect(ok.ok && ok.body.attendees).toEqual(['a@x.com']);
    expect(buildEventBody('microsoft', '2026-12-01T10:00', 30, 'nope')).toEqual({ ok: false, error: 'calBadAttendees' });
  });
  it('refuses a missing time and durations outside 5 minutes to 12 hours', () => {
    expect(buildEventBody('google', '', 60, '')).toEqual({ ok: false, error: 'calBadTime' });
    expect(buildEventBody('google', '2026-12-01T10:00', 0, '')).toEqual({ ok: false, error: 'calBadTime' });
    expect(buildEventBody('google', '2026-12-01T10:00', 12 * 60 + 1, '')).toEqual({ ok: false, error: 'calBadTime' });
  });
});

describe('calendarErrorKey', () => {
  it.each([
    [503, 'calNotConfigured'],
    [403, 'calHostOnly'],
    [409, 'calReconnect'],
    [400, 'calBadInput'],
    [429, 'calTooMany'],
    [502, 'calFailed'],
    [500, 'calFailed'],
  ])('%i maps to %s', (status, key) => expect(calendarErrorKey(status)).toBe(key));
});

describe('OAuth return notice', () => {
  it('reads the result the server redirected with, and only known values', () => {
    expect(returnNotice('?calendar=connected&provider=google')).toEqual({ kind: 'connected', provider: 'google' });
    expect(returnNotice('?calendar=denied&provider=microsoft')).toEqual({ kind: 'denied', provider: 'microsoft' });
    expect(returnNotice('?calendar=error&provider=google')).toEqual({ kind: 'error', provider: 'google' });
    expect(returnNotice('?calendar=pwned&provider=google')).toBeNull();
    expect(returnNotice('?calendar=connected&provider=evil')).toBeNull();
    expect(returnNotice('?join=12345678901')).toBeNull();
  });
  it('strips only its own parameters', () => {
    expect(stripReturnParams('?calendar=connected&provider=google&join=123')).toBe('?join=123');
    expect(stripReturnParams('?calendar=connected&provider=google')).toBe('');
  });
});
