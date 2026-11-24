import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { withTenant } from '../db/tenant.js';
import type { RateLimiter } from '../rate-limit/limiter.js';
import { RateLimitService } from '../rate-limit/service.js';
import type { AuthedUser } from '../auth/auth.guard.js';
import { MeetingError } from '../meetings/meetings.service.js';
import { masterKeyFrom, open, seal } from '../files/crypto.js';
import type { CalendarConfig } from './config.js';
import { google } from './providers/google.js';
import { microsoft } from './providers/microsoft.js';
import { isProvider, type FetchLike, type Provider, type ProviderDef } from './providers/types.js';

const DEFS: Record<Provider, ProviderDef> = { google, microsoft };
const STATE_TTL_SECONDS = 600; // 10 minutes
const ACCESS_TOKEN_SKEW_MS = 60_000;

export interface OAuthDeps {
  fetch?: FetchLike;
  now?: () => number;
  rate?: RateLimitService;
}

export type CallbackResult = { ok: true; provider: Provider } | { ok: false; reason: 'denied' | 'exchange' | 'scope' };

export interface ProviderStatus {
  provider: Provider;
  configured: boolean;
  connected: boolean;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
}

/** The stored refresh token is no longer accepted by the provider: the user has to connect again. */
export class ReconnectRequired extends MeetingError {
  constructor() {
    super(409, 'calendar connection expired, reconnect your calendar');
  }
}

const sha256hex = (s: string) => createHash('sha256').update(s).digest('hex');
const connAad = (userId: string, provider: Provider) => `calendar:${userId}:${provider}`;
const stateAad = (stateHash: string) => `calendar-state:${stateHash}`;

/**
 * OAuth 2.0 authorization code flow with PKCE for Google and Microsoft, and the lifecycle of the stored connection.
 *
 * Security properties:
 *  - state and the PKCE verifier live server side (table calendar_oauth_states, 10 minutes, deleted when consumed);
 *    the state is stored only as a SHA-256 hash and the verifier encrypted;
 *  - the refresh token is the only credential kept, always encrypted with the envelope helpers of file sharing, bound to
 *    (user, provider) through the AAD; access tokens live in process memory only, until they expire;
 *  - the client secret is sent only to the provider's token endpoint, over https;
 *  - without client id/secret, CALENDAR_PUBLIC_URL or FILE_MASTER_KEY the endpoints answer 503.
 */
export class CalendarOAuthService {
  readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly master?: Buffer;
  private readonly startLimiter: RateLimiter;
  private readonly accessCache = new Map<string, { token: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(private readonly pool: Pool, private readonly cfg: CalendarConfig, deps: OAuthDeps = {}) {
    this.startLimiter = (deps.rate ?? RateLimitService.memory()).limiter({ name: 'calstart', max: 20, windowMs: 60_000 });
    this.fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? Date.now;
    if (cfg.FILE_MASTER_KEY) this.master = masterKeyFrom(cfg.FILE_MASTER_KEY);
  }

  private credentials(provider: Provider): { clientId: string; clientSecret: string } | null {
    const c = provider === 'google' ? [this.cfg.GOOGLE_CLIENT_ID, this.cfg.GOOGLE_CLIENT_SECRET] : [this.cfg.MS_CLIENT_ID, this.cfg.MS_CLIENT_SECRET];
    return c[0] && c[1] ? { clientId: c[0], clientSecret: c[1] } : null;
  }

  isConfigured(provider: Provider): boolean {
    return Boolean(this.credentials(provider) && this.cfg.CALENDAR_PUBLIC_URL && this.master);
  }

  /** Validates the provider path segment and that the provider is usable; throws 404 / 503. */
  requireProvider(raw: string): { provider: Provider; def: ProviderDef; clientId: string; clientSecret: string; master: Buffer; redirectUri: string } {
    if (!isProvider(raw)) throw new MeetingError(404, 'unknown calendar provider');
    const creds = this.credentials(raw);
    if (!creds || !this.cfg.CALENDAR_PUBLIC_URL || !this.master) throw new MeetingError(503, 'calendar integration is not configured');
    return { provider: raw, def: DEFS[raw], ...creds, master: this.master, redirectUri: this.redirectUri(raw) };
  }

  redirectUri(provider: Provider): string {
    return `${this.cfg.CALENDAR_PUBLIC_URL!.replace(/\/+$/, '')}/api/v1/calendar/${provider}/callback`;
  }

  /** Where the browser is sent after the callback (a constant on our own origin; nothing from the request is reflected). */
  appRedirect(result: 'connected' | 'denied' | 'error', provider: Provider): string {
    const base = this.cfg.CALENDAR_PUBLIC_URL!.replace(/\/+$/, '');
    return `${base}/app?calendar=${result}&provider=${provider}`;
  }

  async list(user: AuthedUser): Promise<ProviderStatus[]> {
    const rows = await withTenant(this.pool, user.orgId, async (c) => (await c.query('SELECT provider FROM calendar_connections WHERE user_id = $1', [user.userId])).rows as { provider: string }[]);
    const have = new Set(rows.map((r) => r.provider));
    return (Object.keys(DEFS) as Provider[]).map((p) => ({ provider: p, configured: this.isConfigured(p), connected: have.has(p) }));
  }

  /** Step 1: the URL the browser is sent to. */
  async start(user: AuthedUser, rawProvider: string): Promise<{ url: string }> {
    const { provider, def, clientId, master, redirectUri } = this.requireProvider(rawProvider);
    if (!(await this.startLimiter.hit(user.userId)).allowed) throw new MeetingError(429, 'too many attempts, try again in a minute');

    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url'); // 43 characters, RFC 7636 4.1
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const stateHash = sha256hex(state);
    const sealed = seal(master, stateAad(stateHash), Buffer.from(verifier, 'utf8'));
    await this.pool.query('SELECT calendar_state_create($1, $2, $3, $4, $5, $6, $7)', [
      stateHash,
      user.orgId,
      user.userId,
      provider,
      sealed.blob.toString('base64'),
      sealed.wrappedKey,
      STATE_TTL_SECONDS,
    ]);

    const u = new URL(def.authUrl);
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', def.scopes.join(' '));
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    for (const [k, v] of Object.entries(def.authParams)) u.searchParams.set(k, v);
    return { url: u.toString() };
  }

  /**
   * Step 2, called by the browser coming back from the provider (no bearer token: the state row identifies the user).
   * Throws 400 for an unknown, expired, reused or foreign-provider state; returns ok:false for provider-side failures.
   */
  async callback(rawProvider: string, q: { code?: string; state?: string; error?: string }): Promise<CallbackResult> {
    const { provider, def, clientId, clientSecret, master, redirectUri } = this.requireProvider(rawProvider);
    const state = q.state;
    if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(state)) throw new MeetingError(400, 'invalid or expired state');
    if (!(typeof q.code === 'string' && q.code.length > 0 && q.code.length <= 2048) && typeof q.error !== 'string') throw new MeetingError(400, 'invalid or expired state');

    const stateHash = sha256hex(state);
    // Consuming deletes the row: from here on this state can never be used again, whatever happens next.
    const res = await this.pool.query('SELECT * FROM calendar_state_consume($1)', [stateHash]);
    const row = res.rows[0] as { org_id: string; user_id: string; provider: string; verifier_enc: string; wrapped_key: string } | undefined;
    if (!row || row.provider !== provider) throw new MeetingError(400, 'invalid or expired state');

    if (typeof q.error === 'string') return { ok: false, reason: 'denied' };

    let verifier: string;
    try {
      verifier = open(master, stateAad(stateHash), Buffer.from(row.verifier_enc, 'base64'), row.wrapped_key).toString('utf8');
    } catch {
      throw new MeetingError(400, 'invalid or expired state');
    }

    let tok: TokenResponse;
    try {
      const r = await this.fetchFn(def.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: q.code!,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: verifier,
        }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) return { ok: false, reason: 'exchange' };
      tok = (await r.json()) as TokenResponse;
    } catch {
      return { ok: false, reason: 'exchange' };
    }
    if (typeof tok.refresh_token !== 'string' || !tok.refresh_token || typeof tok.access_token !== 'string') return { ok: false, reason: 'exchange' };
    const granted = typeof tok.scope === 'string' ? tok.scope : '';
    if (!def.grantedEnough(granted)) return { ok: false, reason: 'scope' };

    const aad = connAad(row.user_id, provider);
    const sealed = seal(master, aad, Buffer.from(tok.refresh_token, 'utf8'));
    await withTenant(this.pool, row.org_id, async (c) => {
      await c.query(
        `INSERT INTO calendar_connections (user_id, provider, org_id, refresh_token_enc, wrapped_key, scope)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, provider) DO UPDATE
           SET refresh_token_enc = EXCLUDED.refresh_token_enc, wrapped_key = EXCLUDED.wrapped_key, scope = EXCLUDED.scope, updated_at = now()`,
        [row.user_id, provider, row.org_id, sealed.blob.toString('base64'), sealed.wrappedKey, granted],
      );
      await c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [row.org_id, row.user_id, 'calendar.connect', provider]);
    });
    this.cacheAccess(row.user_id, provider, tok);
    return { ok: true, provider };
  }

  /** Deletes the stored token (and revokes it at the provider where one exists). Idempotent. */
  async disconnect(user: AuthedUser, rawProvider: string): Promise<{ disconnected: boolean }> {
    const { provider, def, clientId, clientSecret, master } = this.requireProvider(rawProvider);
    this.accessCache.delete(`${user.userId}:${provider}`);
    const row = await withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query('DELETE FROM calendar_connections WHERE user_id = $1 AND provider = $2 RETURNING refresh_token_enc, wrapped_key', [user.userId, provider]);
      if (r.rowCount) await c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, 'calendar.disconnect', provider]);
      return r.rows[0] as { refresh_token_enc: string; wrapped_key: string } | undefined;
    });
    if (!row) return { disconnected: false };
    if (def.revokeUrl) {
      try {
        const token = open(master, connAad(user.userId, provider), Buffer.from(row.refresh_token_enc, 'base64'), row.wrapped_key).toString('utf8');
        await this.fetchFn(def.revokeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token, client_id: clientId, client_secret: clientSecret }).toString(),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        /* best effort: the local copy is already gone */
      }
    }
    return { disconnected: true };
  }

  private cacheAccess(userId: string, provider: Provider, tok: TokenResponse): void {
    if (typeof tok.access_token !== 'string') return;
    const ttl = typeof tok.expires_in === 'number' && tok.expires_in > 0 ? tok.expires_in : 300;
    this.accessCache.set(`${userId}:${provider}`, { token: tok.access_token, expiresAt: this.now() + ttl * 1000 - ACCESS_TOKEN_SKEW_MS });
  }

  /**
   * A usable access token for the user's connection. Cached in memory until shortly before it expires; `force` skips the
   * cache (after a 401). Concurrent refreshes of one connection share a single request (Microsoft rotates refresh tokens,
   * two parallel refreshes would invalidate each other).
   */
  async accessToken(user: AuthedUser, rawProvider: string, force = false): Promise<string> {
    const { provider } = this.requireProvider(rawProvider);
    const key = `${user.userId}:${provider}`;
    if (!force) {
      const hit = this.accessCache.get(key);
      if (hit && hit.expiresAt > this.now()) return hit.token;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.refresh(user, provider).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async refresh(user: AuthedUser, provider: Provider): Promise<string> {
    const { def, clientId, clientSecret, master } = this.requireProvider(provider);
    const row = await withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query('SELECT refresh_token_enc, wrapped_key FROM calendar_connections WHERE user_id = $1 AND provider = $2', [user.userId, provider]);
      return r.rows[0] as { refresh_token_enc: string; wrapped_key: string } | undefined;
    });
    if (!row) throw new MeetingError(409, `${provider} calendar is not connected`);
    const refreshToken = open(master, connAad(user.userId, provider), Buffer.from(row.refresh_token_enc, 'base64'), row.wrapped_key).toString('utf8');

    let r: Response;
    try {
      r = await this.fetchFn(def.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new MeetingError(502, 'calendar provider is unreachable, try again');
    }
    if (!r.ok) {
      let err = '';
      try {
        err = String(((await r.json()) as { error?: unknown }).error ?? '');
      } catch {
        /* not json */
      }
      // The grant itself is dead (revoked, expired, password changed): drop it and ask the user to reconnect.
      if ((r.status === 400 || r.status === 401) && (err === 'invalid_grant' || err === 'interaction_required')) {
        await withTenant(this.pool, user.orgId, async (c) => {
          await c.query('DELETE FROM calendar_connections WHERE user_id = $1 AND provider = $2', [user.userId, provider]);
          await c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, 'calendar.expired', provider]);
        });
        this.accessCache.delete(`${user.userId}:${provider}`);
        throw new ReconnectRequired();
      }
      throw new MeetingError(502, 'calendar provider refused the request, try again later');
    }
    const tok = (await r.json()) as TokenResponse;
    if (typeof tok.access_token !== 'string') throw new MeetingError(502, 'calendar provider returned no access token');
    // Providers that rotate refresh tokens (Microsoft): keep the new one, the old one is to be discarded.
    if (typeof tok.refresh_token === 'string' && tok.refresh_token && tok.refresh_token !== refreshToken) {
      const sealed = seal(master, connAad(user.userId, provider), Buffer.from(tok.refresh_token, 'utf8'));
      await withTenant(this.pool, user.orgId, (c) =>
        c.query('UPDATE calendar_connections SET refresh_token_enc = $3, wrapped_key = $4, updated_at = now() WHERE user_id = $1 AND provider = $2', [
          user.userId,
          provider,
          sealed.blob.toString('base64'),
          sealed.wrappedKey,
        ]),
      );
    }
    this.cacheAccess(user.userId, provider, tok);
    return tok.access_token;
  }
}
