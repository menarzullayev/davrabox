import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';

// The API image is distroless (no shell, no curl), so its container healthcheck is `node dist/healthcheck.js <path>`.
// This runs the very same script (through tsx) against servers that behave in the ways a real API can.
const servers: Array<http.Server | net.Server> = [];
afterAll(() => servers.forEach((s) => s.close()));

function serve(handler: http.RequestListener): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    servers.push(s);
    s.listen(0, '127.0.0.1', () => resolve((s.address() as net.AddressInfo).port));
  });
}

function runCheck(port: number, path: string, extraEnv: Record<string, string> = {}): Promise<{ code: number | null; ms: number }> {
  return new Promise((resolve) => {
    const t = Date.now();
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/healthcheck.ts', path], { env: { ...process.env, API_PORT: String(port), ...extraEnv }, stdio: 'ignore' });
    p.on('close', (code) => resolve({ code, ms: Date.now() - t }));
  });
}

describe('container healthcheck script', () => {
  it('exits 0 on 200', async () => {
    const port = await serve((_q, r) => r.end('{"status":"ok"}'));
    expect((await runCheck(port, '/readyz')).code).toBe(0);
  });
  it('asks for the path it is given', async () => {
    const seen: string[] = [];
    const port = await serve((q, r) => { seen.push(q.url ?? ''); r.end('ok'); });
    await runCheck(port, '/readyz');
    expect(seen).toEqual(['/readyz']);
  });
  it('exits 1 on 503 (not ready)', async () => {
    const port = await serve((_q, r) => { r.statusCode = 503; r.end('{}'); });
    expect((await runCheck(port, '/readyz')).code).toBe(1);
  });
  it('exits 1 when nothing listens', async () => {
    const s = net.createServer();
    const port = await new Promise<number>((res) => s.listen(0, '127.0.0.1', () => res((s.address() as net.AddressInfo).port)));
    await new Promise((res) => s.close(res));
    expect((await runCheck(port, '/healthz')).code).toBe(1);
  });
  it('exits 1 within its timeout when the API accepts the connection but never answers', async () => {
    const port = await serve(() => undefined);
    const r = await runCheck(port, '/healthz', { HEALTHCHECK_TIMEOUT_MS: '500' });
    expect(r.code).toBe(1);
    expect(r.ms).toBeLessThan(5000);
  }, 15_000);
  it('refuses a path that is not a plain absolute path (no host injection)', async () => {
    const port = await serve((_q, r) => r.end('ok'));
    expect((await runCheck(port, '//evil.example/x')).code).toBe(1);
    expect((await runCheck(port, 'http://evil.example/')).code).toBe(1);
  });
});
