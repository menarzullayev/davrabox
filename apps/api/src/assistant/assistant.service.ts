import { createHmac } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { isConfident, searchFaq, type HelpContent, type HelpLang, type SearchHit } from '@davrabox/help-content/search';
import { ipKey } from '../rate-limit/client-ip.js';
import type { RateLimiter } from '../rate-limit/limiter.js';
import type { RateLimitService } from '../rate-limit/service.js';
import { costMicroUsd, type AssistantSettings } from './config.js';
import type { LlmAdapter, LlmTurn } from './llm.js';
import { cleanText, maskPersonalData } from './mask.js';
import { OFF_TOPIC, REPLIES, systemPrompt } from './prompt.js';

export const PAGES = ['landing', 'help', 'signin', 'home'] as const;
export type AssistantPage = (typeof PAGES)[number];
export type AnswerSource = 'faq' | 'llm' | 'fallback' | 'refusal';

export interface AskInput {
  message: string;
  lang: HelpLang;
  page: AssistantPage;
  conversationId?: string | null;
}

export interface AskContext {
  ip: string;
  /** The request carries a verified token of a platform owner (needed for the staging CLI adapter). */
  owner: boolean;
}

export interface Suggestion {
  id: string;
  q: string;
}

export interface AskResult {
  conversationId: string;
  answer: string;
  source: AnswerSource;
  faqId: string | null;
  lang: HelpLang;
  suggestions: Suggestion[];
}

export interface AssistantStatus {
  enabled: boolean;
  /** 'llm' when a language model may answer this caller right now, 'faq' when only FAQ answers are given. */
  mode: 'llm' | 'faq';
  maxChars: number;
  retentionDays: number;
}

export class AssistantError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfter?: number) {
    super(message);
  }
}

const LANGS: HelpLang[] = ['uz', 'ru', 'en'];
const HISTORY = 8;
const TURN_CHARS = 1500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AssistantDeps {
  rate: RateLimitService;
  llm: LlmAdapter | null;
  now?: () => number;
}

/**
 * The help assistant (decisions 5-5e). Order of an answer: FAQ match first; otherwise a language model if one is
 * configured, allowed for this caller and today's caps are not reached; otherwise a fixed reply with the closest FAQ
 * topics. Everything stored is masked first. No tools, no account or meeting data is ever given to the model.
 */
export class AssistantService {
  private readonly log = new Logger('Assistant');
  private readonly perMinute: RateLimiter;
  private readonly perDay: RateLimiter;

  constructor(private readonly pool: Pool, readonly settings: AssistantSettings, private readonly content: HelpContent, private readonly deps: AssistantDeps) {
    this.perMinute = deps.rate.limiter({ name: 'assistant-min', max: settings.ipPerMinute, windowMs: 60_000 });
    this.perDay = deps.rate.limiter({ name: 'assistant-day', max: settings.ipPerDay, windowMs: 86_400_000 });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  ipHash(ip: string): string {
    return createHmac('sha256', this.settings.ipHashKey).update(ipKey(ip)).digest('hex').slice(0, 32);
  }

  private llmFor(ctx: Pick<AskContext, 'owner'>): LlmAdapter | null {
    const llm = this.deps.llm;
    if (!llm) return null;
    // The subscription-backed CLI answers the platform owner only (staging tests); everyone else gets FAQ mode.
    if (llm.kind === 'claude-cli' && !ctx.owner) return null;
    return llm;
  }

  private async underCaps(): Promise<boolean> {
    const r = await this.pool.query<{ llm_requests: number; cost_micro_usd: string }>('SELECT llm_requests, cost_micro_usd FROM assistant_usage_get($1)', [this.today()]);
    const row = r.rows[0];
    const cost = Number(row?.cost_micro_usd ?? 0);
    return (row?.llm_requests ?? 0) < this.settings.dailyLlmRequests && cost < this.settings.dailyUsdCap * 1_000_000;
  }

  async status(ctx: Pick<AskContext, 'owner'>): Promise<AssistantStatus> {
    const llm = this.settings.enabled ? this.llmFor(ctx) : null;
    const mode = llm && (await this.underCaps()) ? 'llm' : 'faq';
    return { enabled: this.settings.enabled, mode, maxChars: this.settings.maxChars, retentionDays: this.settings.retentionDays };
  }

  /** Best FAQ hit over the three languages (the user may type Russian on an Uzbek page); ties go to the page language. */
  private bestHit(lang: HelpLang, text: string): { lang: HelpLang; hits: SearchHit[] } {
    let best = { lang, hits: searchFaq(this.content, lang, text) };
    for (const l of LANGS) {
      if (l === lang) continue;
      const hits = searchFaq(this.content, l, text);
      if ((hits[0]?.score ?? 0) > (best.hits[0]?.score ?? 0) + 0.01) best = { lang: l, hits };
    }
    return best;
  }

  private entry(id: string) {
    return this.content.faq.find((e) => e.id === id);
  }

  private suggestions(lang: HelpLang, hits: SearchHit[]): Suggestion[] {
    return hits.slice(0, 3).flatMap((h) => {
      const e = this.entry(h.id);
      return e ? [{ id: e.id, q: e[lang].q }] : [];
    });
  }

  private async append(conv: string | null, input: AskInput, ipHash: string, role: 'user' | 'assistant', source: AnswerSource | null, faqId: string | null, text: string): Promise<string> {
    const r = await this.pool.query<{ id: string }>('SELECT assistant_append($1, $2, $3, $4, $5, $6, $7, $8) AS id', [
      conv, input.lang, input.page, ipHash, role, source, faqId, maskPersonalData(text).slice(0, 4000),
    ]);
    return r.rows[0]!.id;
  }

  async ask(input: AskInput, ctx: AskContext): Promise<AskResult> {
    if (!this.settings.enabled) throw new AssistantError(503, 'disabled', 'the help assistant is switched off');
    const raw = cleanText(input.message);
    if (!raw) throw new AssistantError(400, 'invalid_input', 'the message is empty');
    if ([...raw].length > this.settings.maxChars) throw new AssistantError(413, 'too_long', 'the message is too long');
    const key = ipKey(ctx.ip);
    const minute = await this.perMinute.hit(key);
    if (!minute.allowed) throw new AssistantError(429, 'rate_limited', 'too many questions, please wait a moment', minute.retryAfterSec);
    const day = await this.perDay.hit(key);
    if (!day.allowed) throw new AssistantError(429, 'daily_limit', 'the daily question limit is reached', day.retryAfterSec);

    const text = maskPersonalData(raw);
    const ipHash = this.ipHash(ctx.ip);
    const prior = input.conversationId && UUID.test(input.conversationId) ? input.conversationId : null;
    const conv = await this.append(prior, input, ipHash, 'user', null, null, text);

    const { lang: hitLang, hits } = this.bestHit(input.lang, text);
    const top = hits[0];
    if (top && isConfident(top)) {
      const e = this.entry(top.id)!;
      const answer = e[hitLang].a;
      await this.append(conv, input, ipHash, 'assistant', 'faq', e.id, answer);
      return { conversationId: conv, answer, source: 'faq', faqId: e.id, lang: hitLang, suggestions: this.suggestions(hitLang, hits.slice(1)) };
    }

    const llm = this.llmFor(ctx);
    if (llm && (await this.underCaps())) {
      try {
        const answered = await this.askModel(llm, conv, input.lang);
        if (answered) {
          await this.append(conv, input, ipHash, 'assistant', answered.source, null, answered.answer);
          return { conversationId: conv, answer: answered.answer, source: answered.source, faqId: null, lang: input.lang, suggestions: answered.source === 'refusal' ? [] : this.suggestions(hitLang, hits) };
        }
      } catch (e) {
        // The provider is down, slow or out of credit: fall back to FAQ mode for this question. No content is logged.
        this.log.warn(`language model unavailable (${llm.kind}): ${(e as Error).name}`);
      }
    }

    const answer = llm ? REPLIES[input.lang].notFound : REPLIES[input.lang].limited;
    await this.append(conv, input, ipHash, 'assistant', 'fallback', null, answer);
    return { conversationId: conv, answer, source: 'fallback', faqId: null, lang: input.lang, suggestions: this.suggestions(hitLang, hits) };
  }

  private async askModel(llm: LlmAdapter, conv: string, lang: HelpLang): Promise<{ answer: string; source: 'llm' | 'refusal' } | null> {
    const hist = await this.pool.query<{ role: 'user' | 'assistant'; text: string }>('SELECT role, text FROM assistant_history($1, $2)', [conv, HISTORY]);
    const turns: LlmTurn[] = hist.rows.map((m) => ({ role: m.role, content: m.text.slice(0, TURN_CHARS) }));
    while (turns.length && turns[0]!.role !== 'user') turns.shift();
    if (!turns.length) return null;
    const res = await llm.ask({ system: systemPrompt(this.content, lang), messages: turns, maxTokens: this.settings.maxOutputTokens });
    const cost = llm.kind === 'anthropic' ? costMicroUsd(this.settings, res.inputTokens, res.outputTokens) : 0;
    await this.pool.query('SELECT * FROM assistant_usage_add($1, $2, $3, $4)', [this.today(), res.inputTokens, res.outputTokens, cost]);
    const out = res.text.trim();
    if (res.refused || !out || out.includes(OFF_TOPIC)) return { answer: REPLIES[lang].offTopic, source: 'refusal' };
    return { answer: out.slice(0, 3000), source: 'llm' };
  }

  // ---- platform owner -------------------------------------------------------------------------------------------

  isOwner(sub: string): boolean {
    return this.settings.ownerSubs.has(sub);
  }

  async list(before: string | null, beforeId: string | null, limit: number) {
    const r = await this.pool.query<{ id: string; created_at: Date; last_at: Date; lang: string; page: string; messages: number; first_question: string | null }>(
      'SELECT * FROM assistant_list($1, $2, $3)',
      [before, beforeId, limit],
    );
    const items = r.rows.map((c) => ({ id: c.id, createdAt: c.created_at.toISOString(), lastAt: c.last_at.toISOString(), lang: c.lang, page: c.page, messages: c.messages, firstQuestion: c.first_question ?? '' }));
    const last = items.length === limit ? items[items.length - 1] : undefined;
    return { items, next: last ? `${last.lastAt}|${last.id}` : null };
  }

  async messages(id: string) {
    if (!UUID.test(id)) return [];
    const r = await this.pool.query<{ role: string; source: string | null; faq_id: string | null; text: string; at: Date }>('SELECT * FROM assistant_history($1, $2)', [id, 200]);
    return r.rows.map((m) => ({ role: m.role, source: m.source, faqId: m.faq_id, text: m.text, at: m.at.toISOString() }));
  }

  async remove(id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    const r = await this.pool.query<{ n: number }>('SELECT assistant_delete($1) AS n', [id]);
    return (r.rows[0]?.n ?? 0) > 0;
  }

  async usageToday() {
    const r = await this.pool.query<{ llm_requests: number; input_tokens: string; output_tokens: string; cost_micro_usd: string }>('SELECT * FROM assistant_usage_get($1)', [this.today()]);
    const u = r.rows[0]!;
    return {
      day: this.today(),
      llm: this.deps.llm?.kind ?? 'none',
      model: this.deps.llm?.kind === 'anthropic' ? this.settings.model : this.deps.llm?.kind === 'claude-cli' ? this.settings.cliModel : null,
      llmRequests: u.llm_requests,
      inputTokens: Number(u.input_tokens),
      outputTokens: Number(u.output_tokens),
      costUsd: Number(u.cost_micro_usd) / 1_000_000,
      dailyUsdCap: this.settings.dailyUsdCap,
      dailyLlmRequests: this.settings.dailyLlmRequests,
      retentionDays: this.settings.retentionDays,
    };
  }
}
