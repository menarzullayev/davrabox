import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { loadConfig } from '../src/config.js';
import { MeetingError, MeetingsService } from '../src/meetings/meetings.service.js';
import { FilesService } from '../src/files/files.service.js';
import { gcmDecrypt, open, openWith, platformWrapper, seal, sealWith } from '../src/files/crypto.js';
import { RecordingService, type EgressState, type MediaPort, type ObjectStore } from '../src/recording/recording.service.js';
import { KmsError } from '../src/byok/key-provider.js';
import { VaultTransitProvider } from '../src/byok/vault-transit.js';
import { vetVaultAddress } from '../src/byok/vault-address.js';
import { KeyResolver } from '../src/byok/key-resolver.js';
import { ByokError, ByokService } from '../src/byok/byok.service.js';
import { UrlRejectedError } from '../src/ext-api/url-guard.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';

// The Vault tests need a real Vault in dev mode with the transit engine reachable at BYOK_TEST_VAULT_ADDR and a root
// token in BYOK_TEST_VAULT_TOKEN (a throw-away container, see docs/byok.md). They are required, like MinIO for files.
const VAULT = process.env.BYOK_TEST_VAULT_ADDR;
const ROOT = process.env.BYOK_TEST_VAULT_TOKEN;
if (!VAULT || !ROOT) throw new Error('BYOK_TEST_VAULT_ADDR and BYOK_TEST_VAULT_TOKEN are required for tests (see docs/byok.md)');

const cfg = { ...loadConfig(), BYOK_ALLOW_PRIVATE_VAULT: true };
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
if (!cfg.S3_ENDPOINT || !cfg.CLAMAV_HOST || !cfg.FILE_MASTER_KEY) throw new Error('S3_ENDPOINT, CLAMAV_HOST and FILE_MASTER_KEY are required for tests (source scripts/devenv.sh)');
const master = Buffer.from(cfg.FILE_MASTER_KEY, 'base64');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const admin = new Pool({ connectionString: adminUrl, max: 2 });
const meetings = new MeetingsService(pool, cfg);
const files = new FilesService(pool, cfg);
const byok = new ByokService(pool, master, { allowPrivate: true });
const { S3_ACCESS_KEY: accessKeyId, S3_SECRET_KEY: secretAccessKey } = cfg;
const s3 = new S3Client({ endpoint: cfg.S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! } });
const sfx = Math.random().toString(36).slice(2, 8);
const slugs: string[] = [];

// --- Vault helpers (root token, only for setting the test up and for playing the customer who revokes) ---------------
async function vault(path: string, method = 'POST', body?: unknown, token = ROOT!): Promise<{ status: number; json: any }> {
  const r = await fetch(`${VAULT}/v1/${path}`, { method, headers: { 'X-Vault-Token': token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
}
async function newKey(): Promise<string> {
  const name = `k-${randomBytes(5).toString('hex')}`;
  expect((await vault(`transit/keys/${name}`)).status).toBe(200);
  return name;
}
/** A token that may only encrypt and decrypt with one key: the policy the customer is told to create. */
async function limitedToken(key: string): Promise<string> {
  const policy = `byok-${key}`;
  const hcl = `path "transit/encrypt/${key}" { capabilities = ["update"] }\npath "transit/decrypt/${key}" { capabilities = ["update"] }`;
  expect((await vault(`sys/policies/acl/${policy}`, 'PUT', { policy: hcl })).status).toBe(204);
  const t = await vault('auth/token/create', 'POST', { policies: [policy], ttl: '1h' });
  return t.json.auth.client_token as string;
}
/** The customer "disables" the key: Vault has no switch, deleting it is the strongest form of revocation. */
async function destroyKey(key: string): Promise<void> {
  await vault(`transit/keys/${key}/config`, 'POST', { deletion_allowed: true });
  expect((await vault(`transit/keys/${key}`, 'DELETE')).status).toBe(204);
}

beforeAll(async () => {
  await vault('sys/mounts/transit', 'POST', { type: 'transit' }); // 400 when already mounted: fine
});

async function mkUser(slug: string, sub: string, role: 'org_admin' | 'member'): Promise<AuthedUser> {
  const r = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, sub, `${sub}@t.local`, sub, role]);
  return { sub, email: `${sub}@t.local`, name: sub, orgSlug: slug, role, orgId: r.rows[0].org_id, userId: r.rows[0].user_id };
}
async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof MeetingError || e instanceof ByokError) return e.status;
    throw e;
  }
}
async function auditActions(orgId: string): Promise<string[]> {
  const r = await admin.query('SELECT action FROM audit_log WHERE org_id = $1 ORDER BY id', [orgId]);
  return r.rows.map((x: { action: string }) => x.action);
}
afterAll(async () => {
  if (slugs.length) await admin.query('DELETE FROM organizations WHERE slug = ANY($1)', [slugs]);
  await pool.end();
  await admin.end();
});

interface TestOrg {
  host: AuthedUser;
  admin: AuthedUser;
  key: string;
  token: string;
}
/** A fresh organization with a host, an org admin and (when `configure`) a BYOK configuration on a fresh Vault key. */
async function setupOrg(tag: string, configure = true): Promise<TestOrg> {
  const slug = `by-${tag}-${sfx}`;
  slugs.push(slug);
  const host = await mkUser(slug, `host-${tag}-${sfx}`, 'member');
  const adm = await mkUser(slug, `adm-${tag}-${sfx}`, 'org_admin');
  const key = await newKey();
  const token = await limitedToken(key);
  if (configure) await byok.put(adm, { addr: VAULT!, token, keyName: key });
  return { host, admin: adm, key, token };
}
async function openMeeting(host: AuthedUser) {
  const m = await meetings.create(host, { title: 'BYOK', waitingRoom: false });
  await meetings.join(host, m.code);
  return m;
}

// ---------------------------------------------------------------------------------------------------------------------
describe('default envelope encryption is unchanged', () => {
  it('the platform wrapper is byte compatible with seal()/open() in both directions', async () => {
    const plain = Buffer.from('compat '.repeat(50));
    const w = platformWrapper(master);
    expect(w.kekId).toBeNull();
    const a = await sealWith(w, 'id-1', plain);
    expect(open(master, 'id-1', a.blob, a.wrappedKey).equals(plain)).toBe(true);
    const b = seal(master, 'id-2', plain);
    expect((await openWith(w, 'id-2', b.blob, b.wrappedKey)).equals(plain)).toBe(true);
  });
});

describe('VaultTransitProvider with a fake fetch', () => {
  type Call = { url: string; init: RequestInit };
  const fake = (respond: (c: Call) => Response | Promise<Response>, calls: Call[] = []) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const c = { url: String(url), init: init ?? {} };
      calls.push(c);
      return respond(c);
    }) as typeof fetch;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const TOKEN = 'hvs.secret-token-value-1234567890';
  const mk = (f: typeof fetch) => new VaultTransitProvider({ addr: 'https://vault.example.com', token: TOKEN, keyName: 'my-key', fetch: f });

  it('uses the documented paths, sends the token only in a header and binds the context as associated_data', async () => {
    const calls: Call[] = [];
    const p = mk(fake((c) => (c.url.includes('/encrypt/') ? json(200, { data: { ciphertext: 'vault:v1:abc' } }) : json(200, { data: { plaintext: Buffer.from('k').toString('base64') } })), calls));
    const wrapped = await p.wrap(Buffer.from('k'), 'file-9');
    expect(wrapped.toString()).toBe('vault:v1:abc');
    expect(calls[0]!.url).toBe('https://vault.example.com/v1/transit/encrypt/my-key');
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toEqual({ plaintext: Buffer.from('k').toString('base64'), associated_data: Buffer.from('file-9').toString('base64') });
    expect((calls[0]!.init.headers as Record<string, string>)['X-Vault-Token']).toBe(TOKEN);
    expect(calls[0]!.url).not.toContain(TOKEN);
    expect(String(calls[0]!.init.body)).not.toContain(TOKEN);
    expect(calls[0]!.init.redirect).toBe('error'); // a redirect must never carry the token to another host
    expect((await p.unwrap(wrapped, 'file-9')).toString()).toBe('k');
    expect(calls[1]!.url).toBe('https://vault.example.com/v1/transit/decrypt/my-key');
  });

  it.each([
    [403, { errors: ['permission denied'] }, 'denied'],
    [400, { errors: ['encryption key not found'] }, 'denied'],
    [400, { errors: ['ciphertext or signature version is disabled due to min_decryption_version'] }, 'denied'],
    [404, { errors: [] }, 'denied'],
    [400, { errors: ['cipher: message authentication failed'] }, 'invalid'],
    [503, { errors: ['Vault is sealed'] }, 'unreachable'],
    [500, { errors: ['boom'] }, 'unreachable'],
    [429, { errors: [] }, 'unreachable'],
  ])('maps HTTP %i to %s', async (code, body, expected) => {
    const p = mk(fake(() => json(code, body)));
    const e = await p.unwrap(Buffer.from('vault:v1:x'), 'c').catch((x) => x);
    expect(e).toBeInstanceOf(KmsError);
    expect((e as KmsError).code).toBe(expected);
    expect((e as KmsError).message).not.toContain(TOKEN);
  });

  it('a network failure or a timeout is "unreachable" and the message does not leak the token', async () => {
    const down = mk(fake(() => Promise.reject(new Error(`connect ECONNREFUSED while sending ${TOKEN}`))));
    const e = await down.wrap(Buffer.from('k'), 'c').catch((x) => x);
    expect((e as KmsError).code).toBe('unreachable');
    expect((e as KmsError).message).not.toContain(TOKEN);
    expect(await down.health()).toBe('unreachable');
  });

  it('a reply without the expected field is rejected instead of being trusted', async () => {
    const p = mk(fake(() => json(200, { data: {} })));
    expect(((await p.wrap(Buffer.from('k'), 'c').catch((x) => x)) as KmsError).code).toBe('invalid');
  });

  it('refuses malformed key names and mounts (no path injection into the Vault URL)', () => {
    for (const keyName of ['../sys/seal', 'a/b', 'a b', '', 'x'.repeat(65), 'k?x=1']) {
      expect(() => new VaultTransitProvider({ addr: 'https://v.example.com', token: 't', keyName })).toThrow();
    }
    for (const mount of ['../sys', '/transit', 'a//b', 'a b', '']) {
      expect(() => new VaultTransitProvider({ addr: 'https://v.example.com', token: 't', keyName: 'k', mount })).toThrow();
    }
    expect(() => new VaultTransitProvider({ addr: 'https://v.example.com', token: 't', keyName: 'k', mount: 'team/transit' })).not.toThrow();
  });
});

describe('Vault address guard (SSRF)', () => {
  const never = async () => {
    throw new Error('the resolver must not be needed');
  };
  it.each([
    'http://vault.example.com', // not https
    'https://127.0.0.1:8200',
    'https://localhost:8200',
    'https://10.0.0.5',
    'https://192.168.1.10:8200',
    'https://169.254.169.254',
    'https://[::1]:8200',
    'https://user:pw@vault.example.com',
    'ftp://vault.example.com',
    'not a url',
  ])('rejects %s by default', async (u) => {
    await expect(vetVaultAddress(u, false, never)).rejects.toBeInstanceOf(UrlRejectedError);
  });
  it('rejects a public name that resolves to a private address', async () => {
    await expect(vetVaultAddress('https://vault.example.com', false, async () => ['10.1.2.3'])).rejects.toBeInstanceOf(UrlRejectedError);
  });
  it('accepts a public https address and returns its origin and the vetted addresses', async () => {
    const v = await vetVaultAddress('https://vault.example.com:8200/', false, async () => ['93.184.216.34']);
    expect(v.origin).toBe('https://vault.example.com:8200');
    expect(v.addresses).toEqual(['93.184.216.34']);
  });
  it('allows private and http addresses only when BYOK_ALLOW_PRIVATE_VAULT is on, and still refuses credentials, paths and queries', async () => {
    expect((await vetVaultAddress('http://127.0.0.1:8200', true, never)).origin).toBe('http://127.0.0.1:8200');
    expect((await vetVaultAddress('https://10.0.0.5:8200', true, never)).origin).toBe('https://10.0.0.5:8200');
    for (const bad of ['http://u:p@127.0.0.1:8200', 'http://127.0.0.1:8200/v1/x', 'http://127.0.0.1:8200/?a=1', 'ftp://127.0.0.1']) {
      await expect(vetVaultAddress(bad, true, never)).rejects.toBeInstanceOf(UrlRejectedError);
    }
  });
});

describe('VaultTransitProvider against a real Vault', () => {
  it('wrap and unwrap round-trip, and the context is authenticated', async () => {
    const key = await newKey();
    const p = new VaultTransitProvider({ addr: VAULT!, token: ROOT!, keyName: key });
    const dataKey = randomBytes(32);
    const wrapped = await p.wrap(dataKey, 'file-1');
    expect(wrapped.toString().startsWith('vault:v1:')).toBe(true);
    expect((await p.unwrap(wrapped, 'file-1')).equals(dataKey)).toBe(true);
    expect(((await p.unwrap(wrapped, 'file-2').catch((x) => x)) as KmsError).code).toBe('invalid');
    expect(await p.health()).toBe('ok');
  });
  it('a wrong token is "denied", a dead address is "unreachable", a destroyed key is "denied"', async () => {
    const key = await newKey();
    expect(await new VaultTransitProvider({ addr: VAULT!, token: 'hvs.not-a-token', keyName: key }).health()).toBe('denied');
    expect(await new VaultTransitProvider({ addr: 'http://127.0.0.1:1', token: ROOT!, keyName: key, timeoutMs: 1500 }).health()).toBe('unreachable');
    const tok = await limitedToken(key);
    const p = new VaultTransitProvider({ addr: VAULT!, token: tok, keyName: key });
    expect(await p.health()).toBe('ok');
    await destroyKey(key);
    expect(await p.health()).toBe('denied');
  });
  it('a limited token cannot create a missing key by encrypting against it (no upsert surprise)', async () => {
    const key = await newKey();
    const tok = await limitedToken(key);
    const other = new VaultTransitProvider({ addr: VAULT!, token: tok, keyName: `nokey-${randomBytes(3).toString('hex')}` });
    expect(await other.health()).toBe('denied');
  });
});

describe('BYOK configuration', () => {
  it('stores the Vault address and token only encrypted with the envelope helpers, and never returns the token', async () => {
    const o = await setupOrg('cfg');
    const row = (await admin.query('SELECT config_enc, key_name, kek_id FROM org_kms WHERE org_id = $1', [o.admin.orgId])).rows[0];
    const blob = row.config_enc as Buffer;
    expect(blob.includes(Buffer.from(o.token))).toBe(false);
    expect(blob.includes(Buffer.from('127.0.0.1'))).toBe(false);
    expect(blob.includes(Buffer.from('addr'))).toBe(false);
    const plain = JSON.parse(gcmDecrypt(master, blob, Buffer.from(`kms:${o.admin.orgId}`)).toString());
    expect(plain.token).toBe(o.token);
    expect(row.kek_id).toBe(`vault-transit:transit/${o.key}`);
    const view = await byok.get(o.admin);
    expect(JSON.stringify(view)).not.toContain(o.token);
    expect(view).toMatchObject({ configured: true, provider: 'vault-transit', keyName: o.key, status: 'ok' });
    // the same blob does not decrypt with another organization's context
    expect(() => gcmDecrypt(master, blob, Buffer.from(`kms:${o.host.orgId}-x`))).toThrow();
  });

  it('only an organization admin may read or change it, and every attempt is audited', async () => {
    const o = await setupOrg('perm');
    expect(await status(byok.get(o.host))).toBe(403);
    expect(await status(byok.put(o.host, { addr: VAULT!, token: o.token, keyName: o.key }))).toBe(403);
    expect(await status(byok.test(o.host))).toBe(403);
    expect(await status(byok.remove(o.host))).toBe(403);
    expect(await status(byok.rewrap(o.host, {}))).toBe(403);
    expect(await auditActions(o.admin.orgId)).toContain('kms.configure');
    expect((await auditActions(o.admin.orgId)).filter((a) => a === 'kms.denied').length).toBe(5);
  });

  it('another organization never sees this configuration (row-level security)', async () => {
    const a = await setupOrg('iso-a');
    const b = await setupOrg('iso-b', false);
    expect(await byok.get(b.admin)).toEqual({ configured: false });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.current_org', $1, true)", [b.admin.orgId]);
      expect((await c.query('SELECT 1 FROM org_kms WHERE org_id = $1', [a.admin.orgId])).rowCount).toBe(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('refuses a configuration whose key cannot be used and stores nothing', async () => {
    const o = await setupOrg('bad', false);
    expect(await status(byok.put(o.admin, { addr: VAULT!, token: 'hvs.wrong', keyName: o.key }))).toBe(422);
    expect(await status(byok.put(o.admin, { addr: 'http://127.0.0.1:1', token: o.token, keyName: o.key }))).toBe(422);
    expect(await status(byok.put(o.admin, { addr: VAULT!, token: o.token, keyName: 'does-not-exist' }))).toBe(422);
    expect((await admin.query('SELECT 1 FROM org_kms WHERE org_id = $1', [o.admin.orgId])).rowCount).toBe(0);
    expect((await auditActions(o.admin.orgId)).filter((a) => a === 'kms.configure.failed').length).toBe(3);
  });

  it('rejects private Vault addresses unless BYOK_ALLOW_PRIVATE_VAULT is on, without making any request', async () => {
    const o = await setupOrg('ssrf', false);
    const calls: string[] = [];
    const strict = new ByokService(pool, master, {
      allowPrivate: false,
      fetch: (async (u: string) => {
        calls.push(String(u));
        return new Response('{}');
      }) as typeof fetch,
    });
    for (const addr of ['https://127.0.0.1:8200', 'https://169.254.169.254', 'https://10.0.0.1', 'http://vault.example.com', 'https://localhost']) {
      expect(await status(strict.put(o.admin, { addr, token: 'hvs.x', keyName: o.key }))).toBe(400);
    }
    expect(calls).toEqual([]);
    expect((await admin.query('SELECT 1 FROM org_kms WHERE org_id = $1', [o.admin.orgId])).rowCount).toBe(0);
    expect((await auditActions(o.admin.orgId)).filter((a) => a === 'kms.configure.refused').length).toBe(5);
  });

  it('the update of an existing configuration is audited as a rotation, the test endpoint records the status', async () => {
    const o = await setupOrg('rot');
    const t2 = await limitedToken(o.key);
    await byok.put(o.admin, { addr: VAULT!, token: t2, keyName: o.key });
    const row = (await admin.query('SELECT rotated_at FROM org_kms WHERE org_id = $1', [o.admin.orgId])).rows[0];
    expect(row.rotated_at).not.toBeNull();
    expect(await byok.test(o.admin)).toMatchObject({ status: 'ok' });
    await destroyKey(o.key);
    expect(await byok.test(o.admin)).toMatchObject({ status: 'denied' });
    expect((await byok.get(o.admin)) as { status: string }).toMatchObject({ status: 'denied' });
    const acts = await auditActions(o.admin.orgId);
    expect(acts).toEqual(expect.arrayContaining(['kms.configure', 'kms.rotate', 'kms.test']));
  });

  it('switching to a different key is refused while objects are wrapped by the current one', async () => {
    const o = await setupOrg('swap');
    const m = await openMeeting(o.host);
    await files.upload(o.host, m.code, 'a.txt', Buffer.from('hello'));
    const key2 = await newKey();
    const tok2 = await limitedToken(key2);
    expect(await status(byok.put(o.admin, { addr: VAULT!, token: tok2, keyName: key2 }))).toBe(409);
    expect((await byok.get(o.admin)) as { keyName: string }).toMatchObject({ keyName: o.key });
  });
});

describe('files with the customer key', () => {
  it('new files are wrapped by the customer key; files written before BYOK still open with the platform key', async () => {
    const o = await setupOrg('f1', false);
    const m = await openMeeting(o.host);
    const before = await files.upload(o.host, m.code, 'before.txt', Buffer.from('written before byok'));
    await byok.put(o.admin, { addr: VAULT!, token: o.token, keyName: o.key });
    const after = await files.upload(o.host, m.code, 'after.txt', Buffer.from('written after byok'));
    const rows = (await admin.query('SELECT id, kek_id, wrapped_key, object_key FROM meeting_files WHERE meeting_id = $1', [m.id])).rows;
    const rb = rows.find((r: { id: string }) => r.id === before.id);
    const ra = rows.find((r: { id: string }) => r.id === after.id);
    expect(rb.kek_id).toBeNull();
    expect(ra.kek_id).toBe(`vault-transit:transit/${o.key}`);
    expect(Buffer.from(ra.wrapped_key, 'base64').toString().startsWith('vault:v1:')).toBe(true);
    expect((await files.download(o.host, m.code, before.id)).data.toString()).toBe('written before byok');
    expect((await files.download(o.host, m.code, after.id)).data.toString()).toBe('written after byok');
    const raw = Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: cfg.S3_BUCKET, Key: ra.object_key }))).Body!.transformToByteArray());
    expect(raw.includes(Buffer.from('written after'))).toBe(false);
    // the platform master key alone can no longer open the customer-wrapped file
    expect(() => open(master, after.id, raw, ra.wrapped_key)).toThrow();
  });

  it('fails closed with 423 and an audit row when the customer key is disabled; nothing falls back to the platform key', async () => {
    const o = await setupOrg('f2');
    const m = await openMeeting(o.host);
    const f = await files.upload(o.host, m.code, 'secret.txt', Buffer.from('customer secret'));
    expect((await files.download(o.host, m.code, f.id)).data.toString()).toBe('customer secret');
    await destroyKey(o.key);
    expect(await status(files.download(o.host, m.code, f.id))).toBe(423);
    const acts = await auditActions(o.admin.orgId);
    expect(acts).toContain('file.download.denied');
    expect(acts.filter((a) => a === 'file.download').length).toBe(1); // only the successful one before the revocation
    // new uploads are refused as well and store nothing, not even under the platform key
    const countBefore = (await admin.query('SELECT count(*)::int AS n FROM meeting_files WHERE meeting_id = $1', [m.id])).rows[0].n;
    expect(await status(files.upload(o.host, m.code, 'new.txt', Buffer.from('x')))).toBe(423);
    expect((await admin.query('SELECT count(*)::int AS n FROM meeting_files WHERE meeting_id = $1', [m.id])).rows[0].n).toBe(countBefore);
    expect(acts).not.toContain('file.upload.denied'); // recorded after the call below
    expect(await auditActions(o.admin.orgId)).toContain('file.upload.denied');
    expect((await byok.get(o.admin)) as { status: string }).toMatchObject({ status: 'denied' });
  });

  it('answers 503 with an audit row when the customer Vault is unreachable, and does not fall back', async () => {
    const o = await setupOrg('f3');
    const m = await openMeeting(o.host);
    const f = await files.upload(o.host, m.code, 'secret.txt', Buffer.from('customer secret'));
    // Point the stored configuration at a dead address (the customer's Vault went away).
    const { encryptConfig } = await import('../src/byok/key-resolver.js');
    await admin.query('UPDATE org_kms SET config_enc = $2 WHERE org_id = $1', [o.admin.orgId, encryptConfig(master, o.admin.orgId, { addr: 'http://127.0.0.1:1', token: o.token, mount: 'transit' })]);
    expect(await status(files.download(o.host, m.code, f.id))).toBe(503);
    expect(await status(files.upload(o.host, m.code, 'n.txt', Buffer.from('x')))).toBe(503);
    const acts = await auditActions(o.admin.orgId);
    expect(acts).toContain('file.download.denied');
    expect(acts).toContain('file.upload.denied');
    expect((await admin.query('SELECT count(*)::int AS n FROM meeting_files WHERE meeting_id = $1', [m.id])).rows[0].n).toBe(1);
  });

  it('a file wrapped by a key that is no longer the configured one is 423, never platform-decrypted', async () => {
    const o = await setupOrg('f4');
    const m = await openMeeting(o.host);
    const f = await files.upload(o.host, m.code, 'a.txt', Buffer.from('hello'));
    await admin.query("UPDATE meeting_files SET kek_id = 'vault-transit:transit/some-other-key' WHERE id = $1", [f.id]);
    expect(await status(files.download(o.host, m.code, f.id))).toBe(423);
    expect(await auditActions(o.admin.orgId)).toContain('file.download.denied');
  });

  it('re-wrap moves old objects to the customer key, resumably, with audit rows; removal is blocked until they are moved back', async () => {
    const o = await setupOrg('f5', false);
    const m = await openMeeting(o.host);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await files.upload(o.host, m.code, `old${i}.txt`, Buffer.from(`old file ${i}`))).id);
    await byok.put(o.admin, { addr: VAULT!, token: o.token, keyName: o.key });
    expect((await byok.get(o.admin)) as { wrapped: { files: number } }).toMatchObject({ wrapped: { files: 0 } });

    let cursor: string | null | undefined;
    let rounds = 0;
    let total = 0;
    do {
      const r = await byok.rewrap(o.admin, { limit: 2, after: cursor ?? undefined });
      total += r.processed;
      cursor = r.next;
      rounds++;
      expect(rounds).toBeLessThan(10);
    } while (cursor);
    expect(total).toBe(3);
    expect(rounds).toBeGreaterThan(1); // it really resumed across calls
    const rows = (await admin.query('SELECT kek_id FROM meeting_files WHERE meeting_id = $1', [m.id])).rows;
    expect(rows.every((r: { kek_id: string }) => r.kek_id === `vault-transit:transit/${o.key}`)).toBe(true);
    expect((await files.download(o.host, m.code, ids[1]!)).data.toString()).toBe('old file 1');
    expect((await auditActions(o.admin.orgId)).filter((a) => a === 'kms.rewrap').length).toBe(rounds);

    // repeating is a no-op
    expect(await byok.rewrap(o.admin, {})).toMatchObject({ processed: 0, remaining: 0, next: null });

    expect(await status(byok.remove(o.admin))).toBe(409);
    const back = await byok.rewrap(o.admin, { target: 'platform' });
    expect(back).toMatchObject({ processed: 3, remaining: 0 });
    await byok.remove(o.admin);
    expect((await byok.get(o.admin)) as { configured: boolean }).toMatchObject({ configured: false });
    expect((await files.download(o.host, m.code, ids[0]!)).data.toString()).toBe('old file 0');
    expect(await auditActions(o.admin.orgId)).toContain('kms.remove');
  });

  it('after a re-wrap to the customer key, disabling the key makes the old objects unreadable too (423)', async () => {
    const o = await setupOrg('f6', false);
    const m = await openMeeting(o.host);
    const f = await files.upload(o.host, m.code, 'old.txt', Buffer.from('old'));
    await byok.put(o.admin, { addr: VAULT!, token: o.token, keyName: o.key });
    await byok.rewrap(o.admin, {});
    await destroyKey(o.key);
    expect(await status(files.download(o.host, m.code, f.id))).toBe(423);
  });

  it('rewrap stops with 423 when the key is gone, keeps what was moved, and moves nothing without a configuration', async () => {
    const o = await setupOrg('f7', false);
    expect(await status(byok.rewrap(o.admin, {}))).toBe(409); // no customer key configured
    const m = await openMeeting(o.host);
    await files.upload(o.host, m.code, 'old.txt', Buffer.from('old'));
    await byok.put(o.admin, { addr: VAULT!, token: o.token, keyName: o.key });
    await destroyKey(o.key);
    expect(await status(byok.rewrap(o.admin, {}))).toBe(423);
    expect((await admin.query('SELECT kek_id FROM meeting_files WHERE meeting_id = $1', [m.id])).rows[0].kek_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('recordings with the customer key', () => {
  const PLAIN = Buffer.concat([Buffer.from('RAW-MP4-MARKER-'), randomBytes(3000)]);
  class MemStore implements ObjectStore {
    objects = new Map<string, Buffer>();
    async ensure(): Promise<void> {}
    async get(key: string): Promise<Readable> {
      const o = this.objects.get(key);
      if (!o) throw new Error('NoSuchKey');
      return Readable.from([o]);
    }
    async put(key: string, body: Readable): Promise<void> {
      const parts: Buffer[] = [];
      for await (const p of body) parts.push(p as Buffer);
      this.objects.set(key, Buffer.concat(parts));
    }
    async delete(key: string): Promise<void> {
      this.objects.delete(key);
    }
  }
  class FakeMedia implements MediaPort {
    started: string[] = [];
    state: EgressState = 'active';
    constructor(private readonly store: MemStore) {}
    async setRecordingFlag(): Promise<void> {}
    async startRoomComposite(_room: string, key: string): Promise<{ egressId: string }> {
      this.started.push(key);
      return { egressId: `EG_${this.started.length}_${sfx}` };
    }
    async stop(): Promise<void> {
      this.state = 'complete';
      this.store.objects.set(this.started[this.started.length - 1]!, Buffer.from(PLAIN));
    }
    async status(): Promise<{ state: EgressState }> {
      return { state: this.state };
    }
  }
  const mkRec = () => {
    const store = new MemStore();
    const media = new FakeMedia(store);
    const keys = new KeyResolver(pool, master, { allowPrivate: true });
    return { store, media, rec: new RecordingService(pool, { media, store, master, keys, settleDelayMs: 20 }) };
  };
  async function record(rec: RecordingService, user: AuthedUser, code: string): Promise<string> {
    const s = await rec.start(user, code);
    await rec.stop(user, code);
    expect(await rec.settleNow(user.orgId, s.id)).toBe('ready');
    return s.id;
  }
  async function drain(s: Readable): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const p of s) parts.push(p as Buffer);
    return Buffer.concat(parts);
  }

  it('a new recording is wrapped by the customer key and round-trips; one made before BYOK still plays', async () => {
    const o = await setupOrg('r1', false);
    const { rec, store } = mkRec();
    const m = await openMeeting(o.host);
    const before = await record(rec, o.host, m.code);
    await byok.put(o.admin, { addr: VAULT!, token: o.token, keyName: o.key });
    const after = await record(rec, o.host, m.code);
    const rows = (await admin.query('SELECT id, kek_id, wrapped_key, object_key FROM recordings WHERE meeting_id = $1', [m.id])).rows;
    expect(rows.find((r: { id: string }) => r.id === before).kek_id).toBeNull();
    const ra = rows.find((r: { id: string }) => r.id === after);
    expect(ra.kek_id).toBe(`vault-transit:transit/${o.key}`);
    expect(Buffer.from(ra.wrapped_key, 'base64').toString().startsWith('vault:v1:')).toBe(true);
    expect(store.objects.get(ra.object_key)!.includes(Buffer.from('RAW-MP4-MARKER-'))).toBe(false);
    expect((await drain((await rec.download(o.admin, after)).stream)).equals(PLAIN)).toBe(true);
    expect((await drain((await rec.download(o.admin, before)).stream)).equals(PLAIN)).toBe(true);
  });

  it('with the key disabled the download is 423 with an audit row and streams nothing; the platform key is not used', async () => {
    const o = await setupOrg('r2');
    const { rec } = mkRec();
    const m = await openMeeting(o.host);
    const id = await record(rec, o.host, m.code);
    await destroyKey(o.key);
    expect(await status(rec.download(o.admin, id))).toBe(423);
    expect(await auditActions(o.admin.orgId)).toContain('recording.download.denied');
    expect((await auditActions(o.admin.orgId)).filter((a) => a === 'recording.download').length).toBe(0);
  });

  it('with the Vault unreachable the download is 503 with an audit row', async () => {
    const o = await setupOrg('r3');
    const { rec } = mkRec();
    const m = await openMeeting(o.host);
    const id = await record(rec, o.host, m.code);
    const { encryptConfig } = await import('../src/byok/key-resolver.js');
    await admin.query('UPDATE org_kms SET config_enc = $2 WHERE org_id = $1', [o.admin.orgId, encryptConfig(master, o.admin.orgId, { addr: 'http://127.0.0.1:1', token: o.token, mount: 'transit' })]);
    expect(await status(rec.download(o.admin, id))).toBe(503);
    expect(await auditActions(o.admin.orgId)).toContain('recording.download.denied');
  });

  it('a recording is not even started when the customer key cannot be used: 423, an audit row, nothing started', async () => {
    const o = await setupOrg('r4a');
    const { rec, media } = mkRec();
    const m = await openMeeting(o.host);
    await destroyKey(o.key);
    expect(await status(rec.start(o.host, m.code))).toBe(423);
    expect(media.started).toEqual([]);
    expect(await auditActions(o.admin.orgId)).toContain('recording.start.denied');
  });

  it('if the key is gone when the recording is finished, it fails, the plaintext staging file is removed and nothing is wrapped with the platform key', async () => {
    const o = await setupOrg('r4');
    const { rec, store } = mkRec();
    const m = await openMeeting(o.host);
    const s = await rec.start(o.host, m.code);
    await destroyKey(o.key); // the customer revokes while the meeting is being recorded
    await rec.stop(o.host, m.code);
    expect(await rec.settleNow(o.host.orgId, s.id)).toBe('failed');
    const row = (await admin.query('SELECT status, wrapped_key, staging_key FROM recordings WHERE id = $1', [s.id])).rows[0];
    expect(row.wrapped_key).toBeNull();
    expect(store.objects.has(row.staging_key)).toBe(false);
    expect(await auditActions(o.admin.orgId)).toContain('recording.encrypt.denied');
  });

  it('re-wrap also moves ready recordings to the customer key', async () => {
    const o = await setupOrg('r5', false);
    const { rec } = mkRec();
    const m = await openMeeting(o.host);
    const id = await record(rec, o.host, m.code);
    await byok.put(o.admin, { addr: VAULT!, token: o.token, keyName: o.key });
    expect(await byok.rewrap(o.admin, {})).toMatchObject({ processed: 1, remaining: 0 });
    expect((await admin.query('SELECT kek_id FROM recordings WHERE id = $1', [id])).rows[0].kek_id).toBe(`vault-transit:transit/${o.key}`);
    expect((await drain((await rec.download(o.admin, id)).stream)).equals(PLAIN)).toBe(true);
  });
});
