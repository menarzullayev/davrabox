import { createHash } from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { open } from '../src/files/crypto.js';
import { WebhooksService } from '../src/ext-api/webhooks.service.js';
import { ExtError } from '../src/ext-api/ext-config.js';
import { MAX_ATTEMPTS, verifySignature } from '../src/ext-api/webhook-signature.js';
import { baseUrl, call, cfg, dnsMap, makeJob, master, mkUser, newKey, owner, pool, posted, poster, posterBehavior, resetWebhookDoubles, resolver, sfx, slug, startApp, stopApp, type Actor } from './ext-harness.js';

// D3: webhooks over real HTTP and real Postgres; DNS and the outgoing HTTP call are test doubles (nothing leaves the machine).
const slugs = { a: slug('wa'), b: slug('wb'), many: slug('wm') };
let adminA: Actor, memberA: Actor, adminB: Actor;
let writeKeyA: string;
const ext = (method: string, path: string, key: string | null, body?: unknown, headers: Record<string, string> = {}) => call(method, `/v1/ext${path}`, key, body, headers);
const SECRET_RE = /^whsec_[A-Za-z0-9_-]{43}$/;
let n = 0;
const url = (tag = 'h') => `https://hooks.example.com/${tag}-${sfx}-${++n}`;

async function addEndpoint(admin: Actor, events: string[], u = url()) {
  const r = await call('POST', '/v1/admin/webhooks', admin.token, { url: u, events });
  expect(r.status, r.text).toBe(201);
  return r.body as { id: string; url: string; events: string[]; secret: string };
}
const deliveriesOf = async (endpointId: string) =>
  (await owner.query('SELECT id, event_id, event_type, body, status, attempts, last_status, last_error, next_attempt_at, delivered_at FROM webhook_deliveries WHERE endpoint_id = $1 ORDER BY created_at, id', [endpointId])).rows;
const makeDue = (endpointId: string) => owner.query('UPDATE webhook_deliveries SET next_attempt_at = now() - interval \'1 second\' WHERE endpoint_id = $1 AND status = \'pending\'', [endpointId]);
const postsTo = (u: string) => posted.filter((p) => p.url.toString() === u);
async function newMeeting(key: string, title = `m-${sfx}-${++n}`) {
  const r = await ext('POST', '/meetings', key, { title, passcode: 'a-secret-passcode' });
  expect(r.status, r.text).toBe(201);
  return r.body as { id: string; code: string; title: string };
}

beforeAll(async () => {
  await startApp();
  adminA = await mkUser(slugs.a, 'wa-admin', 'org_admin', 'Admin A');
  memberA = await mkUser(slugs.a, 'wa-member', 'member', 'Member A');
  adminB = await mkUser(slugs.b, 'wb-admin', 'org_admin', 'Admin B');
  writeKeyA = (await newKey(adminA, ['meetings:read', 'meetings:write'])).secret;
});
beforeEach(async () => {
  resetWebhookDoubles();
  await owner.query('DELETE FROM webhook_endpoints'); // cascades to deliveries: every test starts with a clean slate
});
afterAll(stopApp);

describe('D3 webhook endpoints: management', () => {
  it('only an org admin can manage webhooks', async () => {
    const body = { url: url(), events: ['meeting.created'] };
    expect((await call('POST', '/v1/admin/webhooks', memberA.token, body)).status).toBe(403);
    expect((await call('GET', '/v1/admin/webhooks', memberA.token)).status).toBe(403);
    expect((await call('DELETE', `/v1/admin/webhooks/${crypto.randomUUID()}`, memberA.token)).status).toBe(403);
    expect((await call('GET', `/v1/admin/webhooks/${crypto.randomUUID()}/deliveries`, memberA.token)).status).toBe(403);
    expect((await call('POST', '/v1/admin/webhooks', null, body)).status).toBe(401);
  });

  it('returns the signing secret once and stores it envelope-encrypted, never in plaintext', async () => {
    const e = await addEndpoint(adminA, ['meeting.created', 'meeting.ended']);
    expect(e.secret).toMatch(SECRET_RE);
    const list = await call('GET', '/v1/admin/webhooks', adminA.token);
    expect(list.text).not.toContain(e.secret);
    expect(list.text).not.toContain(e.secret.slice(6));
    const row = list.body.find((x: { id: string }) => x.id === e.id);
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'events', 'id', 'url']);
    const db = await owner.query('SELECT secret_blob, secret_wrapped_key, row_to_json(webhook_endpoints)::text AS raw FROM webhook_endpoints WHERE id = $1', [e.id]);
    expect(db.rows[0].raw).not.toContain(e.secret.slice(6));
    expect(Buffer.from(db.rows[0].secret_blob).includes(Buffer.from(e.secret))).toBe(false);
    // it really is the files/crypto.ts envelope: opening with the master key and the endpoint id (AAD) gives the secret back
    expect(open(master, e.id, db.rows[0].secret_blob, db.rows[0].secret_wrapped_key).toString('utf8')).toBe(e.secret);
    expect(() => open(master, crypto.randomUUID(), db.rows[0].secret_blob, db.rows[0].secret_wrapped_key)).toThrow(); // bound to its own endpoint
  });

  it('validates input with 400: scheme, credentials, events, unknown fields', async () => {
    for (const body of [
      { url: 'http://hooks.example.com/x', events: ['meeting.created'] },
      { url: 'https://u:p@hooks.example.com/x', events: ['meeting.created'] },
      { url: 'not a url', events: ['meeting.created'] },
      { url: url(), events: [] },
      { url: url(), events: ['meeting.created', 'meeting.created'] },
      { url: url(), events: ['meeting.exploded'] },
      { url: url() },
      { events: ['meeting.created'] },
      { url: url(), events: ['meeting.created'], secret: 'chosen-by-me' },
      { url: `https://hooks.example.com/${'a'.repeat(2100)}`, events: ['meeting.created'] },
    ]) {
      expect((await call('POST', '/v1/admin/webhooks', adminA.token, body)).status, JSON.stringify(body).slice(0, 90)).toBe(400);
    }
  });

  it('refuses private, loopback, link-local, metadata and reserved targets at registration (with an audit row)', async () => {
    dnsMap['sneaky.example.com'] = ['10.0.0.8'];
    dnsMap['mapped.example.com'] = ['::ffff:127.0.0.1'];
    dnsMap['split.example.com'] = ['93.184.216.34', '169.254.169.254'];
    const before = (await owner.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'webhook.refused'", [adminA.orgId])).rows[0].n as number;
    const targets = [
      'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest/meta-data/', 'https://[fd00:ec2::254]/x', 'https://10.1.2.3/x',
      'https://192.168.0.10/x', 'https://localhost/x', 'https://db.internal/x', 'https://2130706433/x', 'https://[::ffff:7f00:1]/x',
      'https://sneaky.example.com/x', 'https://mapped.example.com/x', 'https://split.example.com/x', 'https://nxdomain.example.com/x',
    ];
    for (const u of targets) {
      const r = await call('POST', '/v1/admin/webhooks', adminA.token, { url: u, events: ['meeting.created'] });
      expect(r.status, u).toBe(400);
      expect(r.text).not.toMatch(/10\.0\.0\.8|169\.254/); // the answer never leaks what the name resolved to
    }
    expect((await owner.query("SELECT 1 FROM webhook_endpoints WHERE org_id = $1 AND url = ANY($2)", [adminA.orgId, targets])).rowCount).toBe(0);
    const after = (await owner.query("SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND action = 'webhook.refused'", [adminA.orgId])).rows[0].n as number;
    expect(after - before).toBe(targets.length);
  });

  it('refuses a duplicate URL (409) and more than 10 endpoints per organization (409)', async () => {
    const admin = await mkUser(slugs.many, 'wm-admin', 'org_admin');
    const first = url('dup');
    expect((await call('POST', '/v1/admin/webhooks', admin.token, { url: first, events: ['meeting.created'] })).status).toBe(201);
    expect((await call('POST', '/v1/admin/webhooks', admin.token, { url: first, events: ['meeting.ended'] })).status).toBe(409);
    for (let i = 1; i < 10; i++) expect((await call('POST', '/v1/admin/webhooks', admin.token, { url: url('many'), events: ['meeting.created'] })).status).toBe(201);
    expect((await call('POST', '/v1/admin/webhooks', admin.token, { url: url('many'), events: ['meeting.created'] })).status).toBe(409);
  });

  it('is isolated per organization: B cannot list, read deliveries of, or delete an endpoint of A', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    expect((await call('GET', '/v1/admin/webhooks', adminB.token)).body.some((x: { id: string }) => x.id === e.id)).toBe(false);
    expect((await call('GET', `/v1/admin/webhooks/${e.id}/deliveries`, adminB.token)).status).toBe(404);
    expect((await call('DELETE', `/v1/admin/webhooks/${e.id}`, adminB.token)).status).toBe(404);
    expect((await call('GET', '/v1/admin/webhooks/not-a-uuid/deliveries', adminA.token)).status).toBe(404);
    expect((await call('DELETE', '/v1/admin/webhooks/not-a-uuid', adminA.token)).status).toBe(404);
    expect((await call('GET', `/v1/admin/webhooks/${e.id}/deliveries`, adminA.token)).status).toBe(200);
  });

  it('deleting an endpoint (204) removes its deliveries and writes audit rows for create and delete', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    await newMeeting(writeKeyA);
    expect(await deliveriesOf(e.id)).toHaveLength(1);
    expect((await call('DELETE', `/v1/admin/webhooks/${e.id}`, adminA.token)).status).toBe(204);
    expect(await deliveriesOf(e.id)).toHaveLength(0);
    expect((await call('DELETE', `/v1/admin/webhooks/${e.id}`, adminA.token)).status).toBe(404);
    const a = await owner.query("SELECT action FROM audit_log WHERE org_id = $1 AND target LIKE $2 ORDER BY id", [adminA.orgId, `${e.id}%`]);
    expect(a.rows.map((r) => r.action)).toEqual(['webhook.create', 'webhook.delete']);
    expect(JSON.stringify(a.rows)).not.toContain(e.secret.slice(6));
  });

  it('answers 503 instead of storing a secret in the clear when no master key is configured', async () => {
    const svc = new WebhooksService(pool, { master: null, resolver });
    await expect(svc.create(adminA, { url: url(), events: ['meeting.created'] })).rejects.toMatchObject({ status: 503 });
    await expect(svc.create(adminA, { url: url(), events: ['meeting.created'] })).rejects.toBeInstanceOf(ExtError);
  });
});

describe('D3 events and delivery', () => {
  it('meeting.created is queued once for each subscribed endpoint of the same organization only', async () => {
    const sub = await addEndpoint(adminA, ['meeting.created']);
    const other = await addEndpoint(adminA, ['participant.joined']);
    const foreign = await addEndpoint(adminB, ['meeting.created']);
    const m = await newMeeting(writeKeyA, 'Quarterly review');
    const rows = await deliveriesOf(sub.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    const body = JSON.parse(rows[0].body);
    expect(body).toMatchObject({ id: rows[0].event_id, type: 'meeting.created', data: { meetingId: m.id, code: m.code, title: 'Quarterly review', hostUserId: adminA.userId } });
    expect(new Date(body.createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(rows[0].body).not.toMatch(/passcode|a-secret-passcode/); // the meeting passcode never leaves
    expect(await deliveriesOf(other.id)).toHaveLength(0);
    expect(await deliveriesOf(foreign.id)).toHaveLength(0);
  });

  it('also fires for meetings created through the normal API path (database trigger), not only /v1/ext', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    const r = await owner.query("INSERT INTO meetings (org_id, code, title, host_user_id) VALUES ($1, '98765432109', 'direct', $2) RETURNING id", [adminA.orgId, adminA.userId]);
    expect(r.rowCount).toBe(1);
    // the owner role bypasses row-level security but the trigger still runs; the delivery belongs to the same organization
    const rows = await deliveriesOf(e.id);
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].body).data.code).toBe('98765432109');
  });

  it('delivers a signed request that verifies with the documented algorithm, then marks it delivered exactly once', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    const m = await newMeeting(writeKeyA);
    const job = makeJob();
    expect(await job.tick()).toBe(1);
    const mine = postsTo(e.url);
    expect(mine).toHaveLength(1);
    const p = mine[0]!;
    expect(p.address).toBe('93.184.216.34'); // the vetted address, not a fresh lookup
    expect(p.headers['Content-Type']).toBe('application/json');
    expect(p.headers['X-Davra-Event']).toBe('meeting.created');
    const sig = p.headers['X-Davra-Signature']!;
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifySignature(e.secret, sig, p.body)).toBe(true);
    expect(verifySignature(e.secret, sig, `${p.body} `)).toBe(false);
    expect(verifySignature('whsec_wrong', sig, p.body)).toBe(false);
    expect(JSON.parse(p.body).data.meetingId).toBe(m.id);
    expect(p.headers['X-Davra-Event-Id']).toBe(JSON.parse(p.body).id);
    const rows = await deliveriesOf(e.id);
    expect(rows[0]).toMatchObject({ status: 'delivered', attempts: 1, last_status: 204 });
    expect(rows[0].delivered_at).not.toBeNull();
    expect(await job.tick()).toBe(0); // nothing left
    expect(postsTo(e.url)).toHaveLength(1);
  });

  it('retries after a failure with exponential backoff and delivers once on success', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    await newMeeting(writeKeyA);
    const job = makeJob();
    let calls = 0;
    posterBehavior.fn = async () => ({ status: ++calls === 1 ? 500 : 200 });
    await job.tick();
    let row = (await deliveriesOf(e.id))[0];
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_status: 500, last_error: 'HTTP 500' });
    const wait = (new Date(row.next_attempt_at).getTime() - Date.now()) / 1000;
    expect(wait).toBeGreaterThan(15); // ~30 s +-25 %: backed off, not hammered
    expect(wait).toBeLessThan(45);
    expect(await job.tick()).toBe(0); // not due yet: no second request
    expect(postsTo(e.url)).toHaveLength(1);
    await makeDue(e.id);
    await job.tick();
    row = (await deliveriesOf(e.id))[0];
    expect(row).toMatchObject({ status: 'delivered', attempts: 2, last_status: 200 });
    const [first, second] = postsTo(e.url);
    expect(JSON.parse(first!.body).id).toBe(JSON.parse(second!.body).id); // same event id on every attempt: consumers can dedupe
    await makeDue(e.id);
    expect(await job.tick()).toBe(0);
    expect(postsTo(e.url)).toHaveLength(2); // delivered once
  });

  it('records network errors as failed attempts and keeps retrying', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    await newMeeting(writeKeyA);
    posterBehavior.fn = async () => {
      throw new Error('connection failed: ECONNREFUSED');
    };
    await makeJob().tick();
    const row = (await deliveriesOf(e.id))[0];
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_status: null, last_error: 'connection failed: ECONNREFUSED' });
  });

  it('a redirect response is a failed attempt: it is never followed and never counts as delivered', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    await newMeeting(writeKeyA);
    posterBehavior.fn = async () => ({ status: 302 });
    await makeJob().tick();
    expect((await deliveriesOf(e.id))[0]).toMatchObject({ status: 'pending', attempts: 1, last_status: 302, last_error: 'HTTP 302' });
    expect(posted).toHaveLength(1); // exactly one request: no second request to a Location target
  });

  it('gives up after 8 attempts, marks the delivery dead and lists it as a dead letter', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    await newMeeting(writeKeyA);
    posterBehavior.fn = async () => ({ status: 503 });
    const job = makeJob();
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
      await makeDue(e.id);
      await job.tick();
      const row = (await deliveriesOf(e.id))[0];
      expect(row.attempts).toBe(i);
      expect(row.status).toBe(i < MAX_ATTEMPTS ? 'pending' : 'dead');
    }
    await makeDue(e.id);
    expect(await job.tick()).toBe(0);
    expect(postsTo(e.url)).toHaveLength(MAX_ATTEMPTS); // no ninth request
    const dead = await call('GET', `/v1/admin/webhooks/${e.id}/deliveries?status=dead`, adminA.token);
    expect(dead.status).toBe(200);
    expect(dead.body.items).toHaveLength(1);
    expect(dead.body.items[0]).toMatchObject({ eventType: 'meeting.created', status: 'dead', attempts: MAX_ATTEMPTS, lastStatus: 503, lastError: 'HTTP 503' });
    expect(Object.keys(dead.body.items[0]).sort()).toEqual(['attempts', 'createdAt', 'deliveredAt', 'eventId', 'eventType', 'id', 'lastError', 'lastStatus', 'nextAttemptAt', 'status']);
    expect(JSON.stringify(dead.body)).not.toContain(e.secret.slice(6));
    expect((await call('GET', `/v1/admin/webhooks/${e.id}/deliveries?status=pending`, adminA.token)).body.items).toHaveLength(0);
    expect((await call('GET', `/v1/admin/webhooks/${e.id}/deliveries?status=bogus`, adminA.token)).status).toBe(400);
  });

  it('deliveries survive an API restart: a brand new job with a brand new connection pool delivers them', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    await newMeeting(writeKeyA);
    posterBehavior.fn = async () => ({ status: 500 });
    await makeJob().tick(); // first attempt fails, then "the process dies"
    await makeDue(e.id);
    const reborn = new Pool({ connectionString: cfg.DATABASE_URL, max: 2 });
    try {
      posterBehavior.fn = async () => ({ status: 204 });
      await makeJob(reborn).tick();
    } finally {
      await reborn.end();
    }
    expect((await deliveriesOf(e.id))[0]).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  it('two workers running at once never deliver the same row twice', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    for (let i = 0; i < 10; i++) await newMeeting(writeKeyA);
    const p2 = new Pool({ connectionString: cfg.DATABASE_URL, max: 3 });
    try {
      const a = makeJob(pool);
      const b = makeJob(p2);
      await Promise.all([a.tick(6), b.tick(6), a.tick(6), b.tick(6)]);
    } finally {
      await p2.end();
    }
    const ids = postsTo(e.url).map((p) => p.headers['X-Davra-Delivery']);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect((await deliveriesOf(e.id)).every((r) => r.status === 'delivered' && r.attempts === 1)).toBe(true);
  });

  it('a claimed row is leased: a crashed worker does not block it forever and cannot double-send meanwhile', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    await newMeeting(writeKeyA);
    const claimed = await pool.query('SELECT id FROM webhook_claim_due(10, 60)'); // a worker takes it and dies
    expect(claimed.rowCount).toBeGreaterThanOrEqual(1);
    expect(await makeJob().tick()).toBe(0); // still leased
    await owner.query("UPDATE webhook_deliveries SET next_attempt_at = now() - interval '1 second' WHERE endpoint_id = $1", [e.id]); // lease expired
    expect(await makeJob().tick()).toBe(1);
    expect((await deliveriesOf(e.id))[0]).toMatchObject({ status: 'delivered', attempts: 2 });
  });

  it('re-checks the target at delivery: a name that now resolves to a private address is refused and the request is never made', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    await newMeeting(writeKeyA);
    dnsMap['hooks.example.com'] = ['169.254.169.254']; // DNS rebinding after registration
    await makeJob().tick();
    expect(postsTo(e.url)).toHaveLength(0);
    expect(posted).toHaveLength(0);
    const row = (await deliveriesOf(e.id))[0];
    expect(row.status).toBe('dead');
    expect(row.last_error).toMatch(/^blocked: /);
    expect(row.last_error).not.toContain('169.254');
  });

  it('a mixed public/private answer at delivery is refused too', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    await newMeeting(writeKeyA);
    dnsMap['hooks.example.com'] = ['93.184.216.34', '10.0.0.1'];
    await makeJob().tick();
    expect(posted).toHaveLength(0);
    expect((await deliveriesOf(e.id))[0].status).toBe('dead');
  });

  it('a temporary DNS failure at delivery is retried, not killed', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    await newMeeting(writeKeyA);
    delete dnsMap['hooks.example.com'];
    await makeJob().tick();
    expect(posted).toHaveLength(0);
    expect((await deliveriesOf(e.id))[0]).toMatchObject({ status: 'pending', attempts: 1 });
    expect((await deliveriesOf(e.id))[0].last_error).toMatch(/could not be resolved/);
  });

  it('a worker without a master key does not claim anything (it cannot sign)', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    await newMeeting(writeKeyA);
    expect(await makeJob(pool, { master: null }).tick()).toBe(0);
    expect((await deliveriesOf(e.id))[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('pages through deliveries with a stable cursor', async () => {
    const e = await addEndpoint(adminA, ['meeting.created']);
    for (let i = 0; i < 5; i++) await newMeeting(writeKeyA);
    const p1 = await call('GET', `/v1/admin/webhooks/${e.id}/deliveries?limit=2`, adminA.token);
    const p2 = await call('GET', `/v1/admin/webhooks/${e.id}/deliveries?limit=2&cursor=${encodeURIComponent(p1.body.next)}`, adminA.token);
    const p3 = await call('GET', `/v1/admin/webhooks/${e.id}/deliveries?limit=2&cursor=${encodeURIComponent(p2.body.next)}`, adminA.token);
    const ids = [...p1.body.items, ...p2.body.items, ...p3.body.items].map((x: { id: string }) => x.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(p3.body.next).toBeNull();
    expect((await call('GET', `/v1/admin/webhooks/${e.id}/deliveries?cursor=junk`, adminA.token)).status).toBe(400);
  });
});

describe('D3 media server (LiveKit) webhook ingestion', () => {
  const hook = async (payload: unknown, opts: { token?: string | null; contentType?: string; key?: string; secret?: string; raw?: string } = {}) => {
    const body = opts.raw ?? JSON.stringify(payload);
    let token = opts.token;
    if (token === undefined) {
      const at = new AccessToken(opts.key ?? cfg.LIVEKIT_API_KEY, opts.secret ?? cfg.LIVEKIT_API_SECRET);
      at.sha256 = createHash('sha256').update(body).digest('base64');
      token = await at.toJwt();
    }
    const res = await fetch(`${baseUrl()}/v1/livekit/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': opts.contentType ?? 'application/webhook+json', ...(token ? { Authorization: token } : {}) },
      body,
    });
    return { status: res.status, text: await res.text() };
  };
  const evt = (event: string, room: string, extra: Record<string, unknown> = {}) => ({
    event,
    id: `EV_${Math.random().toString(36).slice(2, 12)}`,
    createdAt: String(Math.floor(Date.now() / 1000)),
    room: { sid: 'RM_x', name: room },
    ...extra,
  });

  it('turns participant_joined, participant_left and room_finished into signed webhook events', async () => {
    const m = await newMeeting(writeKeyA);
    const e = await addEndpoint(adminA, ['participant.joined', 'participant.left', 'meeting.ended']);
    const identity = adminA.userId;
    expect((await hook(evt('participant_joined', m.id, { participant: { sid: 'PA_1', identity, name: 'Admin A', joinedAt: '1700000000' } }))).status).toBe(200);
    expect((await hook(evt('participant_left', m.id, { participant: { sid: 'PA_1', identity, name: 'Admin A', joinedAt: '1700000000' } }))).status).toBe(200);
    expect((await hook(evt('room_finished', m.id))).status).toBe(200);
    const rows = await deliveriesOf(e.id);
    expect(rows.map((r) => r.event_type).sort()).toEqual(['meeting.ended', 'participant.joined', 'participant.left']);
    const joined = JSON.parse(rows.find((r) => r.event_type === 'participant.joined').body);
    expect(joined.data).toMatchObject({ meetingId: m.id, meetingCode: m.code, participant: { identity, name: 'Admin A' } });
    expect(Object.keys(joined.data.participant).sort()).toEqual(['identity', 'name']); // no tokens, no metadata
    expect(JSON.parse(rows.find((r) => r.event_type === 'meeting.ended').body).data).toMatchObject({ meetingId: m.id, meetingCode: m.code });
    await makeJob().tick();
    expect(postsTo(e.url)).toHaveLength(3);
  });

  it('rejects unsigned, wrongly signed and tampered requests with 401 and queues nothing', async () => {
    const m = await newMeeting(writeKeyA);
    const e = await addEndpoint(adminA, ['meeting.ended']);
    const good = JSON.stringify(evt('room_finished', m.id));
    const at = new AccessToken(cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET);
    at.sha256 = createHash('sha256').update(good).digest('base64');
    const signedForGood = await at.toJwt();
    expect((await hook(null, { raw: good, token: null })).status).toBe(401); // no Authorization
    expect((await hook(null, { raw: good, token: 'garbage' })).status).toBe(401);
    expect((await hook(null, { raw: good, secret: 'x'.repeat(40) })).status).toBe(401); // signed with another secret
    expect((await hook(null, { raw: good, key: 'APIother' })).status).toBe(401);
    expect((await hook(null, { raw: good.replace('RM_x', 'RM_y'), token: signedForGood })).status).toBe(401); // body changed after signing
    expect(await deliveriesOf(e.id)).toHaveLength(0);
    expect((await hook(null, { raw: good, token: signedForGood })).status).toBe(200);
    expect(await deliveriesOf(e.id)).toHaveLength(1);
  });

  it('refuses a body that was already parsed as plain JSON (415) and an oversized body (413)', async () => {
    const m = await newMeeting(writeKeyA);
    expect((await hook(evt('room_finished', m.id), { contentType: 'application/json' })).status).toBe(415);
    expect((await hook(null, { raw: JSON.stringify({ pad: 'x'.repeat(1_200_000) }) })).status).toBe(413);
  });

  it('acknowledges but ignores unknown rooms, foreign identities and uninteresting events', async () => {
    const m = await newMeeting(writeKeyA);
    const e = await addEndpoint(adminA, ['participant.joined', 'meeting.ended']);
    expect((await hook(evt('room_finished', crypto.randomUUID()))).status).toBe(200); // no such meeting
    expect((await hook(evt('room_finished', 'not-a-meeting-id'))).status).toBe(200);
    expect((await hook(evt('participant_joined', m.id, { participant: { sid: 'PA_2', identity: 'EG_egress_bot', name: 'rec' } }))).status).toBe(200); // not one of our users
    expect((await hook(evt('track_published', m.id, { participant: { sid: 'PA_3', identity: adminA.userId } }))).status).toBe(200);
    expect(await deliveriesOf(e.id)).toHaveLength(0);
  });

  it('a retried media-server event (same id) produces one delivery', async () => {
    const m = await newMeeting(writeKeyA);
    const e = await addEndpoint(adminA, ['meeting.ended']);
    const same = evt('room_finished', m.id);
    expect((await hook(same)).status).toBe(200);
    expect((await hook(same)).status).toBe(200);
    expect(await deliveriesOf(e.id)).toHaveLength(1);
  });

  it('an event of org A\'s meeting never reaches org B\'s endpoint', async () => {
    const m = await newMeeting(writeKeyA);
    const foreign = await addEndpoint(adminB, ['meeting.ended']);
    expect((await hook(evt('room_finished', m.id))).status).toBe(200);
    expect(await deliveriesOf(foreign.id)).toHaveLength(0);
  });
});
