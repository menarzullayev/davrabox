import { createHmac } from 'node:crypto';
import { z } from 'zod';

const bool = z.enum(['0', '1', 'true', 'false']).transform((v) => v === '1' || v === 'true');

const envSchema = z.object({
  ASSISTANT_ENABLED: bool.default(true),
  // Which language model answers questions the FAQ cannot: 'anthropic' (official Claude API; the production choice),
  // 'claude-cli' (the owner's `claude -p` on STAGING only, owner-only requests) or 'none' (FAQ mode). Unset: 'anthropic'
  // when a key exists, otherwise 'none'.
  ASSISTANT_LLM: z.enum(['none', 'anthropic', 'claude-cli']).optional(),
  ANTHROPIC_API_KEY: z.string().min(20).optional(),
  ASSISTANT_MODEL: z.string().min(3).max(80).default('claude-haiku-5-5'),
  // List prices per million tokens of ASSISTANT_MODEL (verify before launch; used for the application's daily cap).
  ASSISTANT_PRICE_IN_PER_MTOK: z.coerce.number().min(0).max(100).default(0.1),
  ASSISTANT_PRICE_OUT_PER_MTOK: z.coerce.number().min(0).max(500).default(0.5),
  // Application-side caps per UTC day. $0.60/day keeps a month under the $20 cap the owner sets in the Anthropic console.
  ASSISTANT_DAILY_USD_CAP: z.coerce.number().min(0).max(1000).default(0.6),
  ASSISTANT_DAILY_LLM_REQUESTS: z.coerce.number().int().min(0).max(100_000).default(400),
  ASSISTANT_IP_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(6),
  ASSISTANT_IP_PER_DAY: z.coerce.number().int().min(1).max(10_000).default(40),
  ASSISTANT_MAX_CHARS: z.coerce.number().int().min(50).max(2000).default(500),
  ASSISTANT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(100).max(4000).default(700),
  // Decision 5d: 30 days. A shorter period may be configured, never a longer one.
  ASSISTANT_RETENTION_DAYS: z.coerce.number().int().min(1).max(30).default(30),
  ASSISTANT_CLI_PATH: z.string().min(1).default('claude'),
  ASSISTANT_CLI_MODEL: z.string().min(1).max(40).default('haiku'),
  ASSISTANT_LLM_TIMEOUT_MS: z.coerce.number().int().min(2000).max(120_000).default(25_000),
  // Deployment kind. The subscription-backed CLI adapter refuses to start unless this says staging or development.
  DAVRA_ENV: z.enum(['production', 'staging', 'development']).default('production'),
  // Keycloak subject ids of the platform owner(s), comma separated: the only people who may read stored conversations.
  PLATFORM_OWNER_SUBS: z.string().default(''),
  SIGNUP_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
});

export type LlmKind = 'none' | 'anthropic' | 'claude-cli';

export interface AssistantSettings {
  enabled: boolean;
  llm: LlmKind;
  apiKey: string | null;
  model: string;
  priceInPerMTok: number;
  priceOutPerMTok: number;
  dailyUsdCap: number;
  dailyLlmRequests: number;
  ipPerMinute: number;
  ipPerDay: number;
  maxChars: number;
  maxOutputTokens: number;
  retentionDays: number;
  cliPath: string;
  cliModel: string;
  llmTimeoutMs: number;
  env: 'production' | 'staging' | 'development';
  ownerSubs: ReadonlySet<string>;
  trustedProxyHops: number;
  /** HMAC key for the stored network-address hash (derived, never logged). */
  ipHashKey: string;
}

export function loadAssistantSettings(env: NodeJS.ProcessEnv, fallbackSecret: string): AssistantSettings {
  // Compose passes an unset `${VAR:-}` as an empty string: treat empty as unset so that defaults apply.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) throw new Error(`Invalid help-assistant configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  const c = parsed.data;
  const llm: LlmKind = c.ASSISTANT_LLM ?? (c.ANTHROPIC_API_KEY ? 'anthropic' : 'none');
  if (llm === 'claude-cli' && c.DAVRA_ENV === 'production') {
    // Anthropic does not allow offering claude.ai subscription limits in a product: the CLI is for the owner's staging tests.
    throw new Error('ASSISTANT_LLM=claude-cli is not allowed when DAVRA_ENV=production (use the Claude API key)');
  }
  return {
    enabled: c.ASSISTANT_ENABLED,
    // Without a key the API adapter cannot run: the assistant stays in FAQ mode instead of failing every question.
    llm: llm === 'anthropic' && !c.ANTHROPIC_API_KEY ? 'none' : llm,
    apiKey: c.ANTHROPIC_API_KEY ?? null,
    model: c.ASSISTANT_MODEL,
    priceInPerMTok: c.ASSISTANT_PRICE_IN_PER_MTOK,
    priceOutPerMTok: c.ASSISTANT_PRICE_OUT_PER_MTOK,
    dailyUsdCap: c.ASSISTANT_DAILY_USD_CAP,
    dailyLlmRequests: c.ASSISTANT_DAILY_LLM_REQUESTS,
    ipPerMinute: c.ASSISTANT_IP_PER_MINUTE,
    ipPerDay: c.ASSISTANT_IP_PER_DAY,
    maxChars: c.ASSISTANT_MAX_CHARS,
    maxOutputTokens: c.ASSISTANT_MAX_OUTPUT_TOKENS,
    retentionDays: c.ASSISTANT_RETENTION_DAYS,
    cliPath: c.ASSISTANT_CLI_PATH,
    cliModel: c.ASSISTANT_CLI_MODEL,
    llmTimeoutMs: c.ASSISTANT_LLM_TIMEOUT_MS,
    env: c.DAVRA_ENV,
    ownerSubs: new Set(c.PLATFORM_OWNER_SUBS.split(',').map((s) => s.trim()).filter(Boolean)),
    trustedProxyHops: c.SIGNUP_TRUSTED_PROXY_HOPS,
    ipHashKey: createHmac('sha256', fallbackSecret).update('davrabox.assistant.iphash.v1').digest('hex'),
  };
}

/** Cost of one call in micro-dollars, rounded up so that the cap is never under-counted. */
export function costMicroUsd(s: Pick<AssistantSettings, 'priceInPerMTok' | 'priceOutPerMTok'>, inputTokens: number, outputTokens: number): number {
  return Math.ceil(inputTokens * s.priceInPerMTok + outputTokens * s.priceOutPerMTok);
}
