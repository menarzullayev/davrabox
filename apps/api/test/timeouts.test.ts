import net from 'node:net';
import http from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { RoomServiceClient } from 'livekit-server-sdk';
import { loadConfig } from '../src/config.js';
import { createPool, loadPoolSettings } from '../src/db/pool.js';
import { scanBuffer } from '../src/files/clamav.js';
import { KeycloakAdmin } from '../src/admin/identity-admin.js';
import { livekitClientOptions, s3ClientOptions, OUTBOUND } from '../src/common/timeouts.js';
import { createPoster } from '../src/ext-api/http-poster.js';
import { pinnedFetch } from '../src/byok/key-resolver.js';
import { VaultTransitProvider } from '../src/byok/vault-transit.js';

// A dependency that accepts the connection and then says nothing is the realistic "hung" failure. Every outbound call
// must give up on its own, and quickly, instead of holding a request (and a pool slot) forever.

const servers: net.Server[] = [];
/** TCP server that accepts and never answers. Optionally trickles one byte every `trickleMs` (defeats idle timeouts). */
function stalled(trickleMs = 0): Promise<{ port: number; sockets: net.Socket[] }> {
  return new Promise((resolve) => {
    const sockets: net.Socket[] = [];
    const s = net.createServer((sock) => {
      sockets.push(sock);
      sock.on('error', () => undefined);
      if (trickleMs) {
        const t = setInterval(() => sock.write('\0'), trickleMs);
        sock.on('close', () => clearInterval(t));
      }
    });
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as net.AddressInfo).port, sockets }));
  });
}
afterAll(() => {
  for (const s of servers) s.close();
});

async function elapsed(fn: () => Promise<unknown>): Promise<{ ms: number; error?: Error }> {
  const t = Date.now();
  try {
    await fn();
    return { ms: Date.now() - t };
  } catch (e) {
    return { ms: Date.now() - t, error: e as Error };
  }
}

describe('Postgres pool', () => {
  const cfg = loadConfig();

  it('has explicit, bounded timeouts by default', () => {
    const s = loadPoolSettings({});
    expect(s.statementTimeoutMs).toBeGreaterThan(0);
    expect(s.queryTimeoutMs).toBeGreaterThan(s.statementTimeoutMs);
    expect(s.connectionTimeoutMs).toBeGreaterThan(0);
    expect(s.connectionTimeoutMs).toBeLessThanOrEqual(10_000);
  });

  it('a statement that runs too long is cancelled by the server (57014)', async () => {
    const pool = createPool(cfg.DATABASE_URL, 2, loadPoolSettings({ DB_STATEMENT_TIMEOUT_MS: '300', DB_QUERY_TIMEOUT_MS: '2000' }));
    const r = await elapsed(() => pool.query('SELECT pg_sleep(5)'));
    expect(r.error).toBeDefined();
    expect((r.error as { code?: string }).code).toBe('57014');
    expect(r.ms).toBeLessThan(2000);
    // the pool is still usable afterwards
    expect((await pool.query('SELECT 1 AS one')).rows[0].one).toBe(1);
    await pool.end();
  });

  it('a hung database server fails the query on the client side (query_timeout), not forever', async () => {
    // A server that completes TCP but never speaks the Postgres protocol: neither connect nor query can finish.
    const { port } = await stalled();
    const pool = createPool(`postgres://u:p@127.0.0.1:${port}/db`, 1, loadPoolSettings({ DB_CONNECT_TIMEOUT_MS: '400', DB_QUERY_TIMEOUT_MS: '600', DB_STATEMENT_TIMEOUT_MS: '300' }));
    const r = await elapsed(() => pool.query('SELECT 1'));
    expect(r.error).toBeDefined();
    expect(r.ms).toBeLessThan(3000);
    await pool.end().catch(() => undefined);
  });

  it('an unreachable database is refused within the connection timeout', async () => {
    // Non-routable address: the SYN is never answered.
    const pool = createPool('postgres://u:p@10.255.255.1:5432/db', 1, loadPoolSettings({ DB_CONNECT_TIMEOUT_MS: '500' }));
    const r = await elapsed(() => pool.query('SELECT 1'));
    expect(r.error).toBeDefined();
    expect(r.ms).toBeLessThan(3000);
    await pool.end().catch(() => undefined);
  });
});

describe('outbound calls give up on a hung peer', () => {
  it('ClamAV: a silent scanner fails the scan within the timeout (fail closed)', async () => {
    const { port } = await stalled();
    const r = await elapsed(() => scanBuffer(Buffer.from('x'), '127.0.0.1', port, 400));
    expect(r.error?.message).toMatch(/timeout/);
    expect(r.ms).toBeLessThan(2000);
  });

  it('ClamAV: a scanner that trickles bytes forever is cut off by the overall deadline, not only by the idle timer', async () => {
    const { port } = await stalled(30);
    const r = await elapsed(() => scanBuffer(Buffer.from('x'), '127.0.0.1', port, 5000, 500));
    expect(r.error).toBeDefined();
    expect(r.ms).toBeLessThan(2500);
  });

  it('LiveKit server SDK: calls carry the configured request timeout', async () => {
    const { port } = await stalled();
    const rooms = new RoomServiceClient(`http://127.0.0.1:${port}`, 'k', 's'.repeat(40), { ...livekitClientOptions(), requestTimeout: 1 });
    const r = await elapsed(() => rooms.listRooms());
    expect(r.error).toBeDefined();
    expect(r.ms).toBeLessThan(4000);
  });

  it('LiveKit client options use a bounded default', () => {
    const o = livekitClientOptions();
    expect(o.requestTimeout).toBeGreaterThan(0);
    expect(o.requestTimeout).toBeLessThanOrEqual(15);
  });

  it('S3: a hung object store fails fast and does not retry for minutes', async () => {
    const { port } = await stalled();
    const s3 = new S3Client({ endpoint: `http://127.0.0.1:${port}`, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: 'a', secretAccessKey: 'b' }, ...s3ClientOptions({ requestTimeoutMs: 400, connectionTimeoutMs: 400, maxAttempts: 1 }) });
    const r = await elapsed(() => s3.send(new HeadBucketCommand({ Bucket: 'bucket' })));
    expect(r.error).toBeDefined();
    expect(r.ms).toBeLessThan(3000);
  });

  it('S3 defaults are explicit and bounded', () => {
    const o = s3ClientOptions();
    expect(OUTBOUND.s3RequestMs).toBeGreaterThan(0);
    expect(OUTBOUND.s3RequestMs).toBeLessThanOrEqual(120_000);
    expect(o.maxAttempts).toBeLessThanOrEqual(3);
  });

  it('Keycloak admin client: a hung identity provider fails the call within its timeout', async () => {
    const { port } = await stalled();
    const kc = new KeycloakAdmin({ baseUrl: `http://127.0.0.1:${port}/auth`, realm: 'r', clientId: 'c', clientSecret: 'x'.repeat(20), timeoutMs: 500 });
    const r = await elapsed(() => kc.deleteUser('some-subject'));
    expect(r.error).toBeDefined();
    expect(r.ms).toBeLessThan(3000);
  });

  it('webhook poster: a peer that never completes the handshake is abandoned at the deadline', async () => {
    const { port } = await stalled();
    const post = createPoster();
    const r = await elapsed(() => post({ url: new URL(`https://127.0.0.1:${port}/hook`), address: '127.0.0.1', body: '{}', headers: { 'content-type': 'application/json' }, timeoutMs: 500 }));
    expect(r.error).toBeDefined();
    expect(r.ms).toBeLessThan(2500);
  });

  it('webhook poster: a peer that trickles bytes forever is cut by the hard deadline', async () => {
    const { port } = await stalled(30);
    const post = createPoster();
    const r = await elapsed(() => post({ url: new URL(`https://127.0.0.1:${port}/hook`), address: '127.0.0.1', body: '{}', headers: {}, timeoutMs: 500 }));
    expect(r.error).toBeDefined();
    expect(r.ms).toBeLessThan(2500);
  });

  it('BYOK Vault: a hung Vault fails the call within its timeout', async () => {
    const srv = http.createServer(() => undefined); // never responds
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    const vault = new VaultTransitProvider({ addr: `http://127.0.0.1:${port}`, token: 't', mount: 'transit', keyName: 'k', timeoutMs: 400 });
    const r = await elapsed(() => vault.wrap(Buffer.alloc(32), 'aad'));
    expect(r.error).toBeDefined();
    expect(r.ms).toBeLessThan(3000);
  });

  it('pinned fetch (customer Vault over https) honours an abort signal on a hung peer', async () => {
    const { port } = await stalled();
    const f = pinnedFetch('127.0.0.1');
    const r = await elapsed(() => f(`https://localhost:${port}/v1/x`, { signal: AbortSignal.timeout(400) }));
    expect(r.error).toBeDefined();
    expect(r.ms).toBeLessThan(2500);
  });
});
