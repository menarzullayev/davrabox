import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import content from '@davrabox/help-content/faq.json' with { type: 'json' };
import type { HelpContent } from '@davrabox/help-content/search';
import { loadConfig } from '../src/config.js';
import { AuthGuard, POOL, VERIFIER } from '../src/auth/auth.guard.js';
import type { Identity } from '../src/auth/jwt.js';
import { RateLimitService } from '../src/rate-limit/service.js';
import { ASSISTANT, AssistantController, AssistantOwnerController, PlatformOwnerGuard } from '../src/assistant/assistant.controller.js';
import { AssistantService } from '../src/assistant/assistant.service.js';
import { loadAssistantSettings } from '../src/assistant/config.js';
import type { LlmAdapter, LlmAnswer, LlmRequest } from '../src/assistant/llm.js';
import { AssistantRetentionJob } from '../src/assistant/retention.job.js';

// Integration: the help assistant over real HTTP against real Postgres (migration 017). The language model is a fake
// that records what it was sent; the real adapters are covered in assistant-unit.test.ts.
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 6 });
const owner = new Pool({ connectionString: adminUrl, max: 2 });
const sfx = Math.random().toString(36).slice(2, 8);
const ORG = `ast-${sfx}`;
const OWNER_SUB = `owner-${sfx}`;

class FakeLlm implements LlmAdapter {
  kind: 'anthropic' | 'claude-cli' = 'anthropic';
  calls: LlmRequest[] = [];
  reply = 'Use the waiting room.';
  fail = false;
  async ask(req: LlmRequest): Promise<LlmAnswer> {
    this.calls.push(req);
    if (this.fail) throw new Error('provider down');
    return { text: this.reply, refused: false, inputTokens: 4000, outputTokens: 100 };
  }
}
const llm = new FakeLlm();

const settings = loadAssistantSettings(
  { ANTHROPIC_API_KEY: 'sk-ant-test-0123456789abcdef', ASSISTANT_IP_PER_MINUTE: '500', ASSISTANT_IP_PER_DAY: '500', PLATFORM_OWNER_SUBS: OWNER_SUB, SIGNUP_TRUSTED_PROXY_HOPS: '1' },
  'y'.repeat(40),
);
// Each test address gets its own counters; the clock is fixed to a far-future day so usage rows never collide.
let day = Date.UTC(2099, 0, 1 + Math.floor(Math.random() * 300));
const rate = RateLimitService.memory();
const svc = new AssistantService(pool, settings, content as HelpContent, { rate, llm, now: () => day });

const TOKENS: Record<string, Identity> = {
  owner: { sub: OWNER_SUB, email: `owner-${sfx}@example.org`, name: 'Owner', orgSlug: ORG, role: 'org_admin' },
  admin: { sub: `admin-${sfx}`, email: `admin-${sfx}@example.org`, name: 'Admin', orgSlug: ORG, role: 'org_admin' },
  ownerMember: { sub: OWNER_SUB, email: `owner-${sfx}@example.org`, name: 'Owner', orgSlug: ORG, role: 'member' },
};
const fakeVerifier = async (t: string): Promise<Identity> => {
  const id = TOKENS[t];
  if (!id) throw new Error('bad token');
  return id;
};

@Module({
  controllers: [AssistantController, AssistantOwnerController],
  providers: [{ provide: POOL, useValue: pool }, { provide: VERIFIER, useValue: fakeVerifier }, { provide: ASSISTANT, useValue: svc }, AuthGuard, PlatformOwnerGuard],
})
class TestModule {}

let app: INestApplication;
let base = '';
let ipN = 1;
const newIp = () => `198.51.100.${ipN++}`;

async function call(method: string, path: string, opts: { body?: unknown; token?: string; ip?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-forwarded-for': opts.ip ?? '203.0.113.9', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* empty */
  }
  return { status: res.status, json, headers: res.headers };
}
const ask = (message: string, extra: Record<string, unknown> = {}, opts: { token?: string; ip?: string } = {}) =>
  call('POST', '/v1/public/assistant/ask', { body: { message, lang: 'en', page: 'landing', ...extra }, ip: opts.ip ?? newIp(), token: opts.token });

const created: string[] = [];
const storedTexts = async (conv: string) => (await owner.query<{ role: string; source: string | null; text: string }>('SELECT role, source, text FROM assistant_messages WHERE conversation_id = $1 ORDER BY id', [conv])).rows;

beforeAll(async () => {
  app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0);
  base = (await app.getUrl()).replace('[::1]', 'localhost');
});
afterAll(async () => {
  await app.close();
  if (created.length) await owner.query('DELETE FROM assistant_conversations WHERE id = ANY($1::uuid[])', [created]);
  await owner.query("DELETE FROM assistant_usage_daily WHERE day >= '2099-01-01'");
  await owner.query('DELETE FROM users WHERE org_id IN (SELECT id FROM organizations WHERE slug = $1)', [ORG]).catch(() => undefined);
  await pool.end();
  await owner.end();
});

describe('help assistant: answers', () => {
  it('answers a FAQ question from the FAQ without calling the model', async () => {
    llm.calls = [];
    const r = await ask('How do I share my screen?');
    expect(r.status).toBe(200);
    created.push(r.json.conversationId);
    expect(r.json.source).toBe('faq');
    expect(r.json.faqId).toBe('screen-share');
    expect(r.json.answer).toBe((content as HelpContent).faq.find((e) => e.id === 'screen-share')!.en.a);
    expect(llm.calls).toHaveLength(0);
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('answers in the language the question was written in', async () => {
    const r = await ask('не работает микрофон', { lang: 'uz' });
    created.push(r.json.conversationId);
    expect(r.json.source).toBe('faq');
    expect(r.json.lang).toBe('ru');
  });

  it('masks phone numbers, e-mail and card numbers before storing', async () => {
    const r = await ask('my phone is +998 90 123 45 67 and mail a.b@corp.uz, card 8600 1234 5678 9012, how do I share screen');
    created.push(r.json.conversationId);
    const rows = await storedTexts(r.json.conversationId);
    expect(rows[0]!.text).toBe('my phone is [phone] and mail [email], card [card], how do I share screen');
    expect(JSON.stringify(rows)).not.toMatch(/123 45 67|a\.b@corp|8600/);
  });

  it('asks the model when the FAQ has no confident answer, with the FAQ as the system prompt and no tools', async () => {
    llm.calls = [];
    llm.reply = 'You can admit people from the waiting room.';
    const r = await ask('can a co-host let latecomers in during a webinar');
    created.push(r.json.conversationId);
    expect(r.json.source).toBe('llm');
    expect(r.json.answer).toBe('You can admit people from the waiting room.');
    const sent = llm.calls[0]!;
    expect(sent.system).toContain('FAQ (English)');
    expect(sent.messages.at(-1)).toEqual({ role: 'user', content: 'can a co-host let latecomers in during a webinar' });
    expect(Object.keys(sent).sort()).toEqual(['maxTokens', 'messages', 'system']);
  });

  it('sends the earlier turns of the same conversation and keeps the conversation id', async () => {
    llm.calls = [];
    const ip = newIp();
    const first = await ask('can a co-host let latecomers in during a webinar', {}, { ip });
    created.push(first.json.conversationId);
    const second = await ask('and what about after the webinar starts', { conversationId: first.json.conversationId }, { ip });
    expect(second.json.conversationId).toBe(first.json.conversationId);
    expect(llm.calls.at(-1)!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('turns an off-topic reply into the fixed refusal', async () => {
    llm.reply = 'OFF_TOPIC';
    const r = await ask('write me a poem about autumn leaves falling');
    created.push(r.json.conversationId);
    expect(r.json.source).toBe('refusal');
    expect(r.json.answer).toMatch(/only answer questions about using DavraBox/);
    expect(r.json.suggestions).toEqual([]);
    llm.reply = 'ok';
  });

  it('falls back to FAQ mode when the provider fails', async () => {
    llm.fail = true;
    const r = await ask('can a co-host let latecomers in during a webinar');
    created.push(r.json.conversationId);
    llm.fail = false;
    expect(r.json.source).toBe('fallback');
    expect(r.json.answer).toMatch(/could not find an exact answer/);
  });

  it('stops calling the model when today\'s spend cap is reached, and records usage', async () => {
    day += 86_400_000; // a fresh day
    const today = new Date(day).toISOString().slice(0, 10);
    // 4000 input + 100 output tokens at $0.10/$0.50 per MTok = 450 micro-dollars; push the day to the cap first.
    await owner.query('INSERT INTO assistant_usage_daily (day, llm_requests, cost_micro_usd) VALUES ($1, 1, $2)', [today, settings.dailyUsdCap * 1_000_000 - 10]);
    llm.calls = [];
    const a = await ask('can a co-host let latecomers in during a webinar');
    created.push(a.json.conversationId);
    expect(a.json.source).toBe('llm');
    const u = await owner.query('SELECT llm_requests, input_tokens, output_tokens, cost_micro_usd FROM assistant_usage_daily WHERE day = $1', [today]);
    expect(u.rows[0]).toMatchObject({ llm_requests: 2, input_tokens: '4000', output_tokens: '100', cost_micro_usd: String(settings.dailyUsdCap * 1_000_000 - 10 + 450) });
    const b = await ask('can a co-host let latecomers in during a webinar');
    created.push(b.json.conversationId);
    expect(b.json.source).toBe('fallback');
    expect(llm.calls).toHaveLength(1);
    const st = await call('GET', '/v1/public/assistant/status');
    expect(st.json.mode).toBe('faq');
  });
});

describe('help assistant: limits', () => {
  it('refuses empty, invalid and too-long questions', async () => {
    expect((await ask('   ')).status).toBe(400);
    expect((await call('POST', '/v1/public/assistant/ask', { body: { message: 'hi', lang: 'de', page: 'landing' } })).status).toBe(400);
    expect((await call('POST', '/v1/public/assistant/ask', { body: { message: 'hi', lang: 'en', page: 'call' } })).status).toBe(400);
    expect((await call('POST', '/v1/public/assistant/ask', { body: { message: 'hi', lang: 'en', page: 'landing', tools: [] } })).status).toBe(400);
    const long = await ask('x'.repeat(settings.maxChars + 1));
    expect(long.status).toBe(413);
  });

  it('limits questions per address per minute', async () => {
    const tight = new AssistantService(pool, { ...settings, ipPerMinute: 2 }, content as HelpContent, { rate: RateLimitService.memory(), llm: null, now: () => day });
    const ip = '192.0.2.77';
    for (let i = 0; i < 2; i++) created.push((await tight.ask({ message: 'how to share screen', lang: 'en', page: 'help' }, { ip, owner: false })).conversationId);
    await expect(tight.ask({ message: 'how to share screen', lang: 'en', page: 'help' }, { ip, owner: false })).rejects.toMatchObject({ status: 429, code: 'rate_limited' });
  });

  it('the staging CLI adapter answers the platform owner only', async () => {
    day += 86_400_000; // the previous test used up the spend cap of its day
    llm.kind = 'claude-cli';
    llm.calls = [];
    const anon = await ask('can a co-host let latecomers in during a webinar');
    created.push(anon.json.conversationId);
    expect(anon.json.source).toBe('fallback');
    expect(anon.json.answer).toMatch(/only answer from the frequently asked questions/);
    const admin = await ask('can a co-host let latecomers in during a webinar', {}, { token: 'admin' });
    created.push(admin.json.conversationId);
    expect(admin.json.source).toBe('fallback');
    const me = await ask('can a co-host let latecomers in during a webinar', {}, { token: 'owner' });
    created.push(me.json.conversationId);
    expect(me.json.source).toBe('llm');
    expect(llm.calls).toHaveLength(1);
    expect((await call('GET', '/v1/public/assistant/status', { token: 'owner' })).json.mode).toBe('llm');
    expect((await call('GET', '/v1/public/assistant/status')).json.mode).toBe('faq');
    llm.kind = 'anthropic';
  });
});

describe('help assistant: platform owner view', () => {
  it('only the platform owner (an org_admin listed in PLATFORM_OWNER_SUBS) can read conversations', async () => {
    expect((await call('GET', '/v1/platform/assistant/conversations')).status).toBe(401);
    expect((await call('GET', '/v1/platform/assistant/conversations', { token: 'admin' })).status).toBe(403);
    expect((await call('GET', '/v1/platform/assistant/conversations', { token: 'ownerMember' })).status).toBe(403);
    expect((await call('GET', '/v1/platform/assistant/owner', { token: 'admin' })).json).toEqual({ owner: false });
    expect((await call('GET', '/v1/platform/assistant/owner', { token: 'owner' })).json).toEqual({ owner: true });
  });

  it('lists, reads and deletes conversations', async () => {
    const r = await ask('How do I share my screen?');
    const id = r.json.conversationId;
    const list = await call('GET', '/v1/platform/assistant/conversations?limit=100', { token: 'owner' });
    expect(list.status).toBe(200);
    const row = list.json.items.find((c: { id: string }) => c.id === id);
    expect(row).toMatchObject({ lang: 'en', page: 'landing', messages: 2, firstQuestion: 'How do I share my screen?' });
    const msgs = await call('GET', `/v1/platform/assistant/conversations/${id}`, { token: 'owner' });
    expect(msgs.json.items.map((m: { role: string; source: string | null }) => [m.role, m.source])).toEqual([['user', null], ['assistant', 'faq']]);
    expect((await call('GET', `/v1/platform/assistant/conversations/${id}`, { token: 'admin' })).status).toBe(403);
    expect((await call('DELETE', `/v1/platform/assistant/conversations/${id}`, { token: 'admin' })).status).toBe(403);
    expect((await call('DELETE', `/v1/platform/assistant/conversations/${id}`, { token: 'owner' })).status).toBe(204);
    expect((await call('GET', `/v1/platform/assistant/conversations/${id}`, { token: 'owner' })).status).toBe(404);
    expect((await call('GET', '/v1/platform/assistant/conversations/not-a-uuid', { token: 'owner' })).status).toBe(404);
    const usage = await call('GET', '/v1/platform/assistant/usage', { token: 'owner' });
    expect(usage.json).toMatchObject({ llm: 'anthropic', model: 'claude-haiku-5-5', retentionDays: 30 });
  });

  it('the application role cannot read the tables directly', async () => {
    await expect(pool.query('SELECT * FROM assistant_messages LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(pool.query('DELETE FROM assistant_conversations')).rejects.toThrow(/permission denied/);
  });
});

describe('help assistant: retention', () => {
  it('deletes conversations whose last message is older than 30 days', async () => {
    const old = await ask('How do I share my screen?');
    const fresh = await ask('How do I share my screen?');
    created.push(old.json.conversationId, fresh.json.conversationId);
    await owner.query("UPDATE assistant_conversations SET last_at = now() - interval '31 days' WHERE id = $1", [old.json.conversationId]);
    const job = new AssistantRetentionJob(pool, 30);
    const r = await job.runOnce();
    expect(r.skipped).toBe(false);
    expect(r.deleted).toBeGreaterThanOrEqual(1);
    const left = await owner.query<{ id: string }>('SELECT id FROM assistant_conversations WHERE id = ANY($1::uuid[])', [[old.json.conversationId, fresh.json.conversationId]]);
    expect(left.rows.map((x) => x.id)).toEqual([fresh.json.conversationId]);
    expect((await owner.query('SELECT 1 FROM assistant_messages WHERE conversation_id = $1', [old.json.conversationId])).rowCount).toBe(0);
  });
});
