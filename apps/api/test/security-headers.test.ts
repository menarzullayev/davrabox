import 'reflect-metadata';
import { Body, Controller, Get, Module, NotFoundException, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { applyApiHardening } from '../src/security-headers.js';

@Controller()
class C {
  @Get('ok') ok() { return { ok: true }; }
  @Post('echo') echo(@Body() b: unknown) { return { got: b }; }
  @Get('missing') missing() { throw new NotFoundException(); }
}
@Module({ controllers: [C] })
class M {}

describe('API baseline response headers', () => {
  it('are present on success, errors and unknown paths (so a JSON error is never sniffed as HTML)', async () => {
    const app = await NestFactory.create(M, { logger: false });
    applyApiHardening(app);
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    for (const path of ['/ok', '/missing', '/nope']) {
      const r = await fetch(base + path);
      expect(r.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(r.headers.get('cross-origin-resource-policy'), path).toBe('same-origin');
      expect(r.headers.get('referrer-policy'), path).toBe('no-referrer');
    }
    await app.close();
  });
  it('without it the headers are absent (the negative case this guards against)', async () => {
    const app = await NestFactory.create(M, { logger: false });
    await app.listen(0, '127.0.0.1');
    const r = await fetch(`http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}/ok`);
    expect(r.headers.get('x-content-type-options')).toBeNull();
    await app.close();
  });
});

// CVE-2026-111497 (Node2Shell): the Brotli decoder bundled with Node < 22.23.4 has an out-of-bounds write. The API must not
// feed attacker-controlled request bodies to any decompressor: body-parser would inflate gzip, deflate and br by default.
describe('request bodies are never decompressed (Brotli decoder is not reachable from the network)', () => {
  async function start(harden: boolean) {
    const app = await NestFactory.create(M, { logger: false });
    if (harden) applyApiHardening(app);
    await app.listen(0, '127.0.0.1');
    return { app, base: `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}` };
  }
  const post = (base: string, enc: string, body: Buffer) => fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': enc }, body: new Uint8Array(body) });

  it('refuses br, gzip and deflate request bodies with 415, and a malformed br body answers the same as a valid one', async () => {
    const { app, base } = await start(true);
    const json = Buffer.from('{"a":1}');
    expect((await post(base, 'br', brotliCompressSync(json))).status).toBe(415);
    expect((await post(base, 'br', Buffer.from([0x3b]))).status).toBe(415); // valid empty stream
    expect((await post(base, 'br', Buffer.from([0xff]))).status).toBe(415); // malformed stream: same answer, no decoder ran
    expect((await post(base, 'gzip', gzipSync(json))).status).toBe(415);
    const plain = await fetch(`${base}/echo`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json });
    expect(plain.status).toBe(201);
    await app.close();
  });

  it('negative control: without the hardening a Brotli body IS decoded (this is what the scanner found)', async () => {
    const { app, base } = await start(false);
    const r = await post(base, 'br', brotliCompressSync(Buffer.from('{"a":1}')));
    expect(r.status).toBe(201);
    await app.close();
  });
});
