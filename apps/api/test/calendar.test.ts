import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { MeetingError, MeetingsService } from '../src/meetings/meetings.service.js';
import { open } from '../src/files/crypto.js';
import { CalendarOAuthService } from '../src/calendar/oauth.service.js';
import { CalendarEventsService } from '../src/calendar/events.service.js';
import { loadCalendarConfig, type CalendarConfig } from '../src/calendar/config.js';
import { GOOGLE_SCOPE } from '../src/calendar/providers/google.js';
import { MS_SCOPES } from '../src/calendar/providers/microsoft.js';
import type { FetchLike } from '../src/calendar/providers/types.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';

// Integration against a real Postgres (RLS, SECURITY DEFINER state functions); the providers are mocked HTTP.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const meetings = new MeetingsService(pool, cfg);
const sfx = Math.random().toString(36).slice(2, 8);
const slugA = `cal-a-${sfx}`;
const slugB = `cal-b-${sfx}`;
const masterB64 = randomBytes(32).toString('base64');
const master = Buffer.from(masterB64, 'base64');

const calCfg: CalendarConfig = {
  GOOGLE_CLIENT_ID: 'g-client-id',
  GOOGLE_CLIENT_SECRET: 'g-client-secret',
  MS_CLIENT_ID: 'ms-client-id',
  MS_CLIENT_SECRET: 'ms-client-secret',
  CALENDAR_PUBLIC_URL: 'https://meet.example.test',
  FILE_MASTER_KEY: masterB64,
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
/** A scriptable provider: handlers are matched by URL prefix, in order; each handler may be a function or a fixed answer. */
function mockProviders() {
  const calls: Call[] = [];
  const queues = new Map<string, Array<(c: Call) => Response>>();
  const on = (prefix: string, ...answers: Array<Response | ((c: Call) => Response)>) => {
    queues.set(prefix, [...answers.map((a) => (typeof a === 'function' ? a : () => a.clone()))]);
  };
  const fetchFn: FetchLike = async (url, init) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? init.body : '',
    };
    calls.push(call);
    for (const [prefix, q] of queues) {
      if (url.startsWith(prefix) && q.length) return q.length === 1 ? q[0]!(call) : q.shift()!(call);
    }
    return new Response('{"error":"unmocked"}', { status: 599 });
  };
  const to = (prefix: string) => calls.filter((c) => c.url.startsWith(prefix));
  return { fetchFn, calls, on, to };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const form = (c: Call) => Object.fromEntries(new URLSearchParams(c.body));

const G_TOKEN = 'https://oauth2.googleapis.com/token';
const G_EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const MS_TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const MS_EVENTS = 'https://graph.microsoft.com/v1.0/me/events';

async function mkUser(slug: string, sub: string, role: 'org_admin' | 'member'): Promise<AuthedUser> {
  const r = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, sub, `${sub}@t.local`, sub, role]);
  return { sub, email: `${sub}@t.local`, name: sub, orgSlug: slug, role, orgId: r.rows[0].org_id, userId: r.rows[0].user_id };
}
async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof MeetingError) return e.status;
    throw e;
  }
}
async function message(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return '';
  } catch (e) {
    if (e instanceof MeetingError) return e.message;
    throw e;
  }
}

let host: AuthedUser, member: AuthedUser, outsider: AuthedUser;
beforeAll(async () => {
  host = await mkUser(slugA, `host-${sfx}`, 'member');
  member = await mkUser(slugA, `mem-${sfx}`, 'member');
  outsider = await mkUser(slugB, `out-${sfx}`, 'member');
});
afterAll(async () => {
  await admin.query('DELETE FROM organizations WHERE slug IN ($1,$2)', [slugA, slugB]);
  await pool.end();
  await admin.end();
});

/** Walks the full browser flow against mocked providers and returns the services plus the mock. */
async function connected(provider: 'google' | 'microsoft', user: AuthedUser, refreshToken = 'rt-initial-secret') {
  const mock = mockProviders();
  const oauth = new CalendarOAuthService(pool, calCfg, { fetch: mock.fetchFn });
  const { url } = await oauth.start(user, provider);
  const state = new URL(url).searchParams.get('state')!;
  if (provider === 'google') mock.on(G_TOKEN, json(200, { access_token: 'at-1', refresh_token: refreshToken, expires_in: 3600, scope: GOOGLE_SCOPE, token_type: 'Bearer' }));
  else mock.on(MS_TOKEN, json(200, { access_token: 'at-1', refresh_token: refreshToken, expires_in: 3600, scope: 'offline_access Calendars.ReadWrite', token_type: 'Bearer' }));
  const out = await oauth.callback(provider, { code: 'auth-code', state });
  expect(out.ok).toBe(true);
  return { mock, oauth };
}

describe('configuration', () => {
  it('treats empty values (docker compose passes unset variables as empty strings) as not configured', () => {
    const c = loadCalendarConfig({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', MS_CLIENT_ID: '', MS_CLIENT_SECRET: '', CALENDAR_PUBLIC_URL: '', FILE_MASTER_KEY: '' });
    expect(c.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(c.CALENDAR_PUBLIC_URL).toBeUndefined();
  });
  it('reads optional keys and rejects a plain-http public url that is not localhost', () => {
    expect(loadCalendarConfig({}).GOOGLE_CLIENT_ID).toBeUndefined();
    expect(() => loadCalendarConfig({ CALENDAR_PUBLIC_URL: 'http://meet.example.com' })).toThrow(/CALENDAR_PUBLIC_URL/);
    expect(loadCalendarConfig({ CALENDAR_PUBLIC_URL: 'http://localhost:5173' }).CALENDAR_PUBLIC_URL).toBe('http://localhost:5173');
  });
});

describe('K1 start: authorization request', () => {
  it('builds a PKCE (S256) request with a state, the exact narrow scopes and the callback redirect_uri', async () => {
    const mock = mockProviders();
    const oauth = new CalendarOAuthService(pool, calCfg, { fetch: mock.fetchFn });
    const g = new URL((await oauth.start(host, 'google')).url);
    expect(g.origin + g.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(g.searchParams.get('client_id')).toBe('g-client-id');
    expect(g.searchParams.get('redirect_uri')).toBe('https://meet.example.test/api/v1/calendar/google/callback');
    expect(g.searchParams.get('response_type')).toBe('code');
    expect(g.searchParams.get('code_challenge_method')).toBe('S256');
    expect(g.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(g.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(g.searchParams.get('access_type')).toBe('offline');
    // calendar events only: no full calendar, no profile, no mail
    expect(g.searchParams.get('scope')).toBe(GOOGLE_SCOPE);
    expect(g.search).not.toContain('client_secret');

    const m = new URL((await oauth.start(host, 'microsoft')).url);
    expect(m.origin + m.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
    expect(m.searchParams.get('scope')!.split(' ')).toEqual([...MS_SCOPES]);
    expect(m.searchParams.get('code_challenge_method')).toBe('S256');
    expect(m.search).not.toContain('client_secret');
  });

  it('answers 503 when the provider (or the master key, or the public url) is not configured, 404 for an unknown provider', async () => {
    const mock = mockProviders();
    const none = new CalendarOAuthService(pool, { ...calCfg, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }, { fetch: mock.fetchFn });
    expect(await status(none.start(host, 'google'))).toBe(503);
    expect((await none.list(host)).find((p) => p.provider === 'google')).toMatchObject({ configured: false, connected: false });
    const noKey = new CalendarOAuthService(pool, { ...calCfg, FILE_MASTER_KEY: undefined }, { fetch: mock.fetchFn });
    expect(await status(noKey.start(host, 'microsoft'))).toBe(503);
    const noUrl = new CalendarOAuthService(pool, { ...calCfg, CALENDAR_PUBLIC_URL: undefined }, { fetch: mock.fetchFn });
    expect(await status(noUrl.start(host, 'microsoft'))).toBe(503);
    const ok = new CalendarOAuthService(pool, calCfg, { fetch: mock.fetchFn });
    expect(await status(ok.start(host, 'yahoo'))).toBe(404);
    expect(mock.calls.length).toBe(0);
  });

  it('stores state server side only as a hash, never the state or the verifier in clear', async () => {
    const mock = mockProviders();
    const oauth = new CalendarOAuthService(pool, calCfg, { fetch: mock.fetchFn });
    const state = new URL((await oauth.start(host, 'google')).url).searchParams.get('state')!;
    const rows = (await admin.query('SELECT * FROM calendar_oauth_states WHERE state_hash = $1', [createHash('sha256').update(state).digest('hex')])).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(state);
    const ttl = (new Date(rows[0].expires_at).getTime() - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(540);
    expect(ttl).toBeLessThanOrEqual(600);
  });
});

describe('K1 callback: state, PKCE and token storage', () => {
  it('rejects a tampered, unknown or missing state with 400 and never calls the provider', async () => {
    const mock = mockProviders();
    const oauth = new CalendarOAuthService(pool, calCfg, { fetch: mock.fetchFn });
    const state = new URL((await oauth.start(host, 'google')).url).searchParams.get('state')!;
    const flipped = state.slice(0, -1) + (state.endsWith('A') ? 'B' : 'A');
    expect(await status(oauth.callback('google', { code: 'c', state: flipped }))).toBe(400);
    expect(await status(oauth.callback('google', { code: 'c', state: 'x'.repeat(43) }))).toBe(400);
    expect(await status(oauth.callback('google', { code: 'c' }))).toBe(400);
    expect(await status(oauth.callback('google', { state }))).toBe(400); // no code and no error
    expect(mock.to(G_TOKEN).length).toBe(0);
  });

  it('a state is single use: the second callback with the same state is rejected', async () => {
    const mock = mockProviders();
    const oauth = new CalendarOAuthService(pool, calCfg, { fetch: mock.fetchFn });
    const state = new URL((await oauth.start(host, 'google')).url).searchParams.get('state')!;
    mock.on(G_TOKEN, json(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: GOOGLE_SCOPE }));
    expect((await oauth.callback('google', { code: 'c', state })).ok).toBe(true);
    expect(await status(oauth.callback('google', { code: 'c', state }))).toBe(400);
    expect(mock.to(G_TOKEN).length).toBe(1);
  });

  it('a state expires after 10 minutes', async () => {
    const mock = mockProviders();
    const oauth = new CalendarOAuthService(pool, calCfg, { fetch: mock.fetchFn });
    const state = new URL((await oauth.start(host, 'google')).url).searchParams.get('state')!;
    await admin.query("UPDATE calendar_oauth_states SET expires_at = now() - interval '1 second' WHERE state_hash = $1", [createHash('sha256').update(state).digest('hex')]);
    expect(await status(oauth.callback('google', { code: 'c', state }))).toBe(400);
    expect(mock.to(G_TOKEN).length).toBe(0);
  });

  it('a state minted for one provider cannot be redeemed on the other provider callback', async () => {
    const mock = mockProviders();
    const oauth = new CalendarOAuthService(pool, calCfg, { fetch: mock.fetchFn });
    const state = new URL((await oauth.start(host, 'google')).url).searchParams.get('state')!;
    expect(await status(oauth.callback('microsoft', { code: 'c', state }))).toBe(400);
    expect(mock.calls.length).toBe(0);
  });

  it('exchanges the code with the PKCE verifier that matches the challenge, and the client secret goes only to the token endpoint', async () => {
    const mock = mockProviders();
    const oauth = new CalendarOAuthService(pool, calCfg, { fetch: mock.fetchFn });
    const url = new URL((await oauth.start(host, 'google')).url);
    mock.on(G_TOKEN, json(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: GOOGLE_SCOPE }));
    await oauth.callback('google', { code: 'the-code', state: url.searchParams.get('state')! });
    const body = form(mock.to(G_TOKEN)[0]!);
    expect(body).toMatchObject({ grant_type: 'authorization_code', code: 'the-code', client_id: 'g-client-id', client_secret: 'g-client-secret', redirect_uri: 'https://meet.example.test/api/v1/calendar/google/callback' });
    expect(createHash('sha256').update(body.code_verifier!).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
  });

  it('the refresh token is stored only encrypted and decrypts to the original; no access token is stored', async () => {
    const secret = 'rt-very-secret-value-' + sfx;
    await connected('google', host, secret);
    const row = (await admin.query('SELECT * FROM calendar_connections WHERE user_id = $1 AND provider = $2', [host.userId, 'google'])).rows[0];
    expect(row.org_id).toBe(host.orgId);
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(Buffer.from(row.refresh_token_enc, 'base64').includes(Buffer.from(secret))).toBe(false);
    expect(open(master, `calendar:${host.userId}:google`, Buffer.from(row.refresh_token_enc, 'base64'), row.wrapped_key).toString()).toBe(secret);
    expect(JSON.stringify(row)).not.toContain('at-1');
    expect(row.scope).toBe(GOOGLE_SCOPE);
    const audit = await admin.query("SELECT target FROM audit_log WHERE org_id = $1 AND action = 'calendar.connect' AND actor_id = $2", [host.orgId, host.userId]);
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it('the stored blob is bound to its user and provider (moved to another record it fails authentication)', async () => {
    await connected('google', host, 'bound-token');
    const row = (await admin.query('SELECT * FROM calendar_connections WHERE user_id = $1 AND provider = $2', [host.userId, 'google'])).rows[0];
    expect(() => open(master, `calendar:${member.userId}:google`, Buffer.from(row.refresh_token_enc, 'base64'), row.wrapped_key)).toThrow();
    expect(() => open(master, `calendar:${host.userId}:microsoft`, Buffer.from(row.refresh_token_enc, 'base64'), row.wrapped_key)).toThrow();
  });

  it('refuses a token response without a refresh token or without the calendar scope, and stores nothing', async () => {
    await admin.query('DELETE FROM calendar_connections WHERE user_id = $1', [member.userId]);
    const mock = mockProviders();
    const oauth = new CalendarOAuthService(pool, calCfg, { fetch: mock.fetchFn });
    const s1 = new URL((await oauth.start(member, 'google')).url).searchParams.get('state')!;
    mock.on(G_TOKEN, json(200, { access_token: 'a', expires_in: 3600, scope: GOOGLE_SCOPE }));
    expect(await oauth.callback('google', { code: 'c', state: s1 })).toMatchObject({ ok: false });
    const s2 = new URL((await oauth.start(member, 'google')).url).searchParams.get('state')!;
    mock.on(G_TOKEN, json(200, { access_token: 'a', refresh_token: 'r', expires_in: 3600, scope: 'openid email' }));
    expect(await oauth.callback('google', { code: 'c', state: s2 })).toMatchObject({ ok: false });
    expect((await admin.query('SELECT 1 FROM calendar_connections WHERE user_id = $1', [member.userId])).rowCount).toBe(0);
  });

  it('a provider token error and a user denial end the flow without storing anything (state still consumed)', async () => {
    const mock = mockProviders();
    const oauth = new CalendarOAuthService(pool, calCfg, { fetch: mock.fetchFn });
    const s1 = new URL((await oauth.start(member, 'google')).url).searchParams.get('state')!;
    expect(await oauth.callback('google', { error: 'access_denied', state: s1 })).toEqual({ ok: false, reason: 'denied' });
    expect(await status(oauth.callback('google', { code: 'c', state: s1 }))).toBe(400);
    const s2 = new URL((await oauth.start(member, 'google')).url).searchParams.get('state')!;
    mock.on(G_TOKEN, json(400, { error: 'invalid_grant' }));
    expect(await oauth.callback('google', { code: 'c', state: s2 })).toEqual({ ok: false, reason: 'exchange' });
    expect((await admin.query('SELECT 1 FROM calendar_connections WHERE user_id = $1', [member.userId])).rowCount).toBe(0);
  });

  it('reconnecting replaces the stored token instead of adding a second row', async () => {
    await connected('google', host, 'first');
    await connected('google', host, 'second');
    const rows = (await admin.query('SELECT * FROM calendar_connections WHERE user_id = $1 AND provider = $2', [host.userId, 'google'])).rows;
    expect(rows).toHaveLength(1);
    expect(open(master, `calendar:${host.userId}:google`, Buffer.from(rows[0].refresh_token_enc, 'base64'), rows[0].wrapped_key).toString()).toBe('second');
  });
});

describe('K1 disconnect and isolation', () => {
  it('disconnect deletes the stored token, revokes it at Google and is audited', async () => {
    const { mock, oauth } = await connected('google', host, 'to-be-revoked');
    mock.on('https://oauth2.googleapis.com/revoke', new Response('{}', { status: 200 }));
    expect((await oauth.list(host)).find((p) => p.provider === 'google')?.connected).toBe(true);
    expect(await oauth.disconnect(host, 'google')).toEqual({ disconnected: true });
    expect((await admin.query('SELECT 1 FROM calendar_connections WHERE user_id = $1 AND provider = $2', [host.userId, 'google'])).rowCount).toBe(0);
    expect(form(mock.to('https://oauth2.googleapis.com/revoke')[0]!).token).toBe('to-be-revoked');
    expect((await oauth.list(host)).find((p) => p.provider === 'google')?.connected).toBe(false);
    const a = await admin.query("SELECT 1 FROM audit_log WHERE org_id = $1 AND action = 'calendar.disconnect' AND actor_id = $2", [host.orgId, host.userId]);
    expect(a.rowCount).toBeGreaterThan(0);
  });

  it('disconnect still deletes the token when the provider revocation fails, and when nothing is connected it is a no-op', async () => {
    const { mock, oauth } = await connected('google', host, 'x');
    mock.on('https://oauth2.googleapis.com/revoke', new Response('boom', { status: 500 }));
    expect(await oauth.disconnect(host, 'google')).toEqual({ disconnected: true });
    expect((await admin.query('SELECT 1 FROM calendar_connections WHERE user_id = $1', [host.userId])).rowCount).toBe(0);
    expect(await oauth.disconnect(host, 'google')).toEqual({ disconnected: false });
  });

  it("one user's (or organization's) connection is invisible and untouchable to others", async () => {
    const { oauth } = await connected('google', host, 'mine');
    expect((await oauth.list(member)).find((p) => p.provider === 'google')?.connected).toBe(false);
    expect((await oauth.list(outsider)).find((p) => p.provider === 'google')?.connected).toBe(false);
    expect(await oauth.disconnect(outsider, 'google')).toEqual({ disconnected: false });
    expect((await admin.query('SELECT 1 FROM calendar_connections WHERE user_id = $1', [host.userId])).rowCount).toBe(1);
    // the application role cannot read the state table at all
    await expect(pool.query('SELECT * FROM calendar_oauth_states')).rejects.toThrow();
  });
});

// ---- K2 -------------------------------------------------------------------------------------------------------

const inOneHour = () => new Date(Date.now() + 3600_000);
const input = (over: Record<string, unknown> = {}) => ({
  provider: 'google' as const,
  start: inOneHour().toISOString(),
  end: new Date(inOneHour().getTime() + 3600_000).toISOString(),
  ...over,
});

async function setup(provider: 'google' | 'microsoft', opts: { passcode?: string; title?: string } = {}) {
  await admin.query('DELETE FROM calendar_connections WHERE user_id = $1', [host.userId]);
  const { mock, oauth } = await connected(provider, host);
  const events = new CalendarEventsService(pool, oauth, calCfg);
  const m = await meetings.create(host, { title: opts.title ?? 'Quarterly review', waitingRoom: false, passcode: opts.passcode });
  return { mock, oauth, events, m };
}

/** An events service with an empty access-token cache (as after a restart), so the first call has to refresh. */
function coldEvents(mock: ReturnType<typeof mockProviders>) {
  return new CalendarEventsService(pool, new CalendarOAuthService(pool, calCfg, { fetch: mock.fetchFn }), calCfg);
}

describe('K2 create event with a join link', () => {
  it('creates a Google event holding the join link and code, returns the event url and audits it', async () => {
    const { mock, events, m } = await setup('google');
    mock.on(G_EVENTS, json(200, { id: 'ev1', htmlLink: 'https://www.google.com/calendar/event?eid=abc' }));
    const out = await events.createEvent(host, m.code, input());
    expect(out).toEqual({ eventUrl: 'https://www.google.com/calendar/event?eid=abc' });
    const call = mock.to(G_EVENTS)[0]!;
    expect(call.headers.Authorization).toBe('Bearer at-1');
    expect(call.url).toContain('sendUpdates=none');
    const body = JSON.parse(call.body);
    expect(body.summary).toBe('Quarterly review');
    expect(body.description).toContain(`https://meet.example.test/?join=${m.code}`);
    expect(body.description).toContain(m.code);
    expect(body.location).toBe(`https://meet.example.test/?join=${m.code}`);
    expect(body.attendees).toEqual([]);
    const a = await admin.query("SELECT target FROM audit_log WHERE org_id = $1 AND action = 'calendar.event.create' AND target LIKE $2", [host.orgId, `${m.code}%`]);
    expect(a.rowCount).toBe(1);
  });

  it('passes optional attendees to the provider (Google sends the invitations) and never mentions a passcode value', async () => {
    const { mock, events, m } = await setup('google', { passcode: 'S3cret-pass-1' });
    mock.on(G_EVENTS, json(200, { htmlLink: 'https://www.google.com/calendar/event?eid=1' }));
    await events.createEvent(host, m.code, input({ attendees: ['ann@example.com', 'bob@example.org'] }));
    const call = mock.to(G_EVENTS)[0]!;
    expect(call.url).toContain('sendUpdates=all');
    expect(JSON.parse(call.body).attendees).toEqual([{ email: 'ann@example.com' }, { email: 'bob@example.org' }]);
    expect(call.body).not.toContain('S3cret-pass-1');
  });

  it('creates a Microsoft event with plain-text body (a hostile title cannot inject HTML) and UTC times', async () => {
    const { mock, events, m } = await setup('microsoft', { title: '<img src=x onerror=alert(1)>' });
    mock.on(MS_EVENTS, json(201, { id: 'x', webLink: 'https://outlook.office365.com/owa/?itemid=1&path=/calendar/item' }));
    const start = '2026-12-01T09:00:00.000Z';
    const out = await events.createEvent(host, m.code, input({ provider: 'microsoft', start, end: '2026-12-01T10:00:00.000Z', attendees: ['ann@example.com'] }));
    expect(out.eventUrl).toContain('outlook.office365.com');
    const body = JSON.parse(mock.to(MS_EVENTS)[0]!.body);
    expect(body.body.contentType).toBe('text');
    expect(body.start).toEqual({ dateTime: '2026-12-01T09:00:00', timeZone: 'UTC' });
    expect(body.attendees).toEqual([{ emailAddress: { address: 'ann@example.com' }, type: 'required' }]);
  });

  it('only the host may create the event: a plain member gets 403, another organization 404, nothing is sent to the provider', async () => {
    const { mock, events, m } = await setup('google');
    await meetings.join(host, m.code);
    expect(await status(events.createEvent(member, m.code, input()))).toBe(403);
    expect(await status(events.createEvent(outsider, m.code, input()))).toBe(404);
    expect(await status(events.createEvent(host, '99999999999', input()))).toBe(404);
    expect(mock.to(G_EVENTS).length).toBe(0);
  });

  it('answers 409 when the host has not connected that provider', async () => {
    const { events, m } = await setup('google');
    expect(await status(events.createEvent(host, m.code, input({ provider: 'microsoft' })))).toBe(409);
  });

  it('a 401 from the provider triggers exactly one token refresh and then succeeds', async () => {
    const { mock, events, m } = await setup('google');
    mock.on(G_EVENTS, json(200, { htmlLink: 'https://www.google.com/calendar/event?eid=1' }));
    await events.createEvent(host, m.code, input()); // the access token cached by the callback is used: no refresh
    expect(mock.to(G_TOKEN).length).toBe(1); // only the code exchange
    // now the cached access token is rejected
    mock.on(G_EVENTS, json(401, { error: { code: 401 } }), json(200, { htmlLink: 'https://www.google.com/calendar/event?eid=2' }));
    mock.on(G_TOKEN, json(200, { access_token: 'at-2', expires_in: 3600 }));
    const out = await events.createEvent(host, m.code, input());
    expect(out.eventUrl).toContain('eid=2');
    const tokenCalls = mock.to(G_TOKEN);
    expect(tokenCalls.length).toBe(2);
    expect(form(tokenCalls[1]!)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-initial-secret' });
    expect(mock.to(G_EVENTS).at(-1)!.headers.Authorization).toBe('Bearer at-2');
  });

  it('a second 401 after the refresh is not retried again (one retry only) and returns 502', async () => {
    const { mock, events, m } = await setup('google');
    mock.on(G_TOKEN, json(200, { access_token: 'at-x', expires_in: 3600 }));
    mock.on(G_EVENTS, json(401, {}));
    expect(await status(events.createEvent(host, m.code, input()))).toBe(502);
    expect(mock.to(G_EVENTS).length).toBe(2);
  });

  it('a failed refresh (revoked grant) returns 409 with a reconnect message and drops the dead token', async () => {
    const { mock, m } = await setup('google');
    const fresh = coldEvents(mock);
    mock.on(G_TOKEN, json(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
    const msg = await message(fresh.createEvent(host, m.code, input()));
    expect(msg).toMatch(/reconnect/i);
    expect(await status(fresh.createEvent(host, m.code, input()))).toBe(409);
    expect((await admin.query('SELECT 1 FROM calendar_connections WHERE user_id = $1 AND provider = $2', [host.userId, 'google'])).rowCount).toBe(0);
  });

  it('a transient refresh failure (5xx) is a 502 and keeps the connection', async () => {
    const { mock, m } = await setup('google');
    const fresh = coldEvents(mock);
    mock.on(G_TOKEN, new Response('oops', { status: 503 }));
    expect(await status(fresh.createEvent(host, m.code, input()))).toBe(502);
    expect((await admin.query('SELECT 1 FROM calendar_connections WHERE user_id = $1 AND provider = $2', [host.userId, 'google'])).rowCount).toBe(1);
  });

  it('Microsoft rotates refresh tokens: the new one replaces the stored one (encrypted)', async () => {
    const { mock, m } = await setup('microsoft');
    const events = coldEvents(mock);
    mock.on(MS_TOKEN, json(200, { access_token: 'at-ms', refresh_token: 'rt-rotated', expires_in: 3599, scope: 'Calendars.ReadWrite' }));
    mock.on(MS_EVENTS, json(201, { webLink: 'https://outlook.office365.com/owa/?itemid=1' }));
    await events.createEvent(host, m.code, input({ provider: 'microsoft' }));
    const row = (await admin.query('SELECT * FROM calendar_connections WHERE user_id = $1 AND provider = $2', [host.userId, 'microsoft'])).rows[0];
    expect(JSON.stringify(row)).not.toContain('rt-rotated');
    expect(open(master, `calendar:${host.userId}:microsoft`, Buffer.from(row.refresh_token_enc, 'base64'), row.wrapped_key).toString()).toBe('rt-rotated');
  });

  it('validates times: end after start, at most 12 hours, ISO with offset, attendees are emails (max 50), no unknown fields', async () => {
    const { mock, events, m } = await setup('google');
    const t0 = inOneHour();
    const iso = (ms: number) => new Date(t0.getTime() + ms).toISOString();
    expect(await status(events.createEvent(host, m.code, input({ start: iso(0), end: iso(0) })))).toBe(400);
    expect(await status(events.createEvent(host, m.code, input({ start: iso(3600_000), end: iso(0) })))).toBe(400);
    expect(await status(events.createEvent(host, m.code, input({ start: iso(0), end: iso(12 * 3600_000 + 1000) })))).toBe(400);
    expect(await status(events.createEvent(host, m.code, input({ start: 'tomorrow', end: iso(3600_000) })))).toBe(400);
    expect(await status(events.createEvent(host, m.code, input({ start: '2026-12-01T10:00:00', end: '2026-12-01T11:00:00' })))).toBe(400); // no offset
    expect(await status(events.createEvent(host, m.code, input({ attendees: ['not-an-email'] })))).toBe(400);
    expect(await status(events.createEvent(host, m.code, input({ attendees: Array.from({ length: 51 }, (_, i) => `u${i}@example.com`) })))).toBe(400);
    expect(await status(events.createEvent(host, m.code, input({ provider: 'yahoo' })))).toBe(400);
    expect(await status(events.createEvent(host, m.code, input({ sendUpdates: 'none' })))).toBe(400);
    expect(mock.to(G_EVENTS).length).toBe(0);
    // exactly 12 hours is allowed
    mock.on(G_EVENTS, json(200, { htmlLink: 'https://www.google.com/calendar/event?eid=12h' }));
    expect(await status(events.createEvent(host, m.code, input({ start: iso(0), end: iso(12 * 3600_000) })))).toBe(200);
  });

  it('does not hand back an event link that points outside the provider (open redirect / phishing guard)', async () => {
    const { mock, events, m } = await setup('google');
    mock.on(G_EVENTS, json(200, { htmlLink: 'https://evil.example/phish' }));
    expect(await status(events.createEvent(host, m.code, input()))).toBe(502);
  });

  it('a provider refusal (403 / 5xx) surfaces as 502 without leaking the provider body', async () => {
    const { mock, events, m } = await setup('google');
    mock.on(G_EVENTS, json(403, { error: { message: 'secret internal detail' } }));
    expect(await message(events.createEvent(host, m.code, input()))).not.toContain('secret internal detail');
    expect(await status(events.createEvent(host, m.code, input()))).toBe(502);
  });
});
