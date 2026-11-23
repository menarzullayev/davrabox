import { afterAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { initErrorTracking, scrubEvent, captureServerError } from '../src/observability/error-tracking.js';

const hostile = () => ({
  event_id: 'e1',
  message: 'failed for Bearer abc.def password=hunter2',
  server_name: 'prod-host-1',
  user: { id: 'u1', email: 'a@b.c', ip_address: '1.2.3.4', username: 'alice' },
  request: {
    url: 'https://davrabox.example/api/meetings/12345678901/join?token=SECRETQ#key=E2EEKEY',
    method: 'POST',
    headers: { Authorization: 'Bearer SECRETTOKEN', Cookie: 'sid=SECRETCOOKIE' },
    cookies: { sid: 'SECRETCOOKIE' },
    query_string: 'token=SECRETQ',
    data: { password: 'hunter2', passcode: '424242', fileName: 'plan.pdf' },
  },
  extra: { body: 'hunter2' },
  contexts: { trace: { trace_id: 't' }, request: { body: 'hunter2' }, device: { name: 'host' } },
  breadcrumbs: [{ category: 'http', message: 'GET /x?token=SECRETQ', data: { url: '/x?token=SECRETQ', body: 'hunter2' } }],
  exception: {
    values: [
      { type: 'Error', value: 'connect postgres://u:dbpass9@db/x', stacktrace: { frames: [{ filename: 'a.js', function: 'f', vars: { secret: 'hunter2' } }] } },
    ],
  },
});

describe('scrubEvent', () => {
  it('removes request bodies, headers, cookies, query strings, user data and local variables', () => {
    const out = JSON.stringify(scrubEvent(hostile() as never));
    for (const s of ['SECRETTOKEN', 'SECRETCOOKIE', 'SECRETQ', 'hunter2', '424242', 'plan.pdf', 'E2EEKEY', 'a@b.c', '1.2.3.4', 'alice', 'prod-host-1', 'dbpass9', 'abc.def']) {
      expect(out, `event leaked ${s}`).not.toContain(s);
    }
  });

  it('keeps what is needed to triage: type, stack frames, method, route-level URL', () => {
    const e = scrubEvent(hostile() as never) as ReturnType<typeof hostile>;
    expect(e.exception.values[0]!.type).toBe('Error');
    expect(e.exception.values[0]!.stacktrace.frames[0]).toMatchObject({ filename: 'a.js', function: 'f' });
    expect(e.request).toMatchObject({ method: 'POST', url: 'https://davrabox.example/api/meetings/12345678901/join' });
    expect(e.contexts.trace).toBeDefined();
  });

  it('tolerates a minimal event', () => {
    expect(() => scrubEvent({} as never)).not.toThrow();
  });
});

describe('initErrorTracking', () => {
  it('is disabled with an empty or missing DSN and never loads the SDK', async () => {
    let loaded = false;
    const load = async () => ((loaded = true), {} as never);
    expect(await initErrorTracking({ GLITCHTIP_DSN: '' }, load)).toBe(false);
    expect(await initErrorTracking({}, load)).toBe(false);
    expect(loaded).toBe(false);
  });

  it('stays disabled (no throw) for a malformed DSN', async () => {
    let loaded = false;
    expect(await initErrorTracking({ GLITCHTIP_DSN: 'not a dsn' }, async () => ((loaded = true), {} as never))).toBe(false);
    expect(loaded).toBe(false);
  });

  it('initialises the SDK without default integrations, tracing or breadcrumbs, and with the scrubber', async () => {
    let opts: Record<string, unknown> | undefined;
    const fake = { initWithoutDefaultIntegrations: (o: Record<string, unknown>) => void (opts = o), onUncaughtExceptionIntegration: () => ({ name: 'u' }), onUnhandledRejectionIntegration: () => ({ name: 'r' }), linkedErrorsIntegration: () => ({ name: 'l' }), dedupeIntegration: () => ({ name: 'd' }), captureException: () => undefined };
    expect(await initErrorTracking({ GLITCHTIP_DSN: 'http://key@glitchtip:8000/1', GLITCHTIP_ENVIRONMENT: 'prod', GLITCHTIP_RELEASE: 'sha-1' }, async () => fake as never)).toBe(true);
    expect(opts).toMatchObject({ dsn: 'http://key@glitchtip:8000/1', environment: 'prod', release: 'sha-1', maxBreadcrumbs: 0 });
    expect(opts!.beforeSend).toBe(scrubEvent);
    expect(opts!.tracesSampleRate).toBeUndefined();
  });
});

describe('end to end with the real SDK', () => {
  let server: Server;
  afterAll(() => new Promise<void>((r) => server?.close(() => r())));

  it('sends a scrubbed envelope to the configured DSN and nothing else', async () => {
    const bodies: string[] = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let b = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'gzip') b = gunzipSync(b);
        bodies.push(`${req.url}\n${b.toString('utf8')}`);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    expect(await initErrorTracking({ GLITCHTIP_DSN: `http://pubkey@127.0.0.1:${port}/7` })).toBe(true);

    const err = new Error('boom postgres://u:dbpass9@db/x Bearer SECRETTOKEN');
    captureServerError(err, { requestId: 'req-1', route: '/meetings/:code' });
    const sdk = await import('@sentry/node');
    await sdk.flush(3000);

    const all = bodies.join('\n');
    expect(all).toContain('/api/7/envelope/');
    expect(all).toContain('boom');
    expect(all).toContain('req-1');
    for (const s of ['dbpass9', 'SECRETTOKEN']) expect(all).not.toContain(s);
    await sdk.close(1000);
  });
});
