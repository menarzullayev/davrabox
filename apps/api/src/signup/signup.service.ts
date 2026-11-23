import { createHash, createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { IdentityAdminError, type NewOrgAdmin, type SignupIdentity } from '../admin/identity-admin.js';
import { createChallenge, inspectSolution, type AltchaChallenge } from './altcha.js';
import { isDisposable } from './disposable-domains.js';
import { emailDomain, normalizeEmail } from './email-normalize.js';
import { domainLimit, ipKey, TRIAL, type SignupSettings } from './limits.js';
import { slugify } from './slug.js';

export type { NewOrgAdmin, SignupIdentity };

/** A refusal with a stable machine-readable `code` (the web client maps it to a message in the user's language). */
export class SignupError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfter?: number,
    /** What the audit row says when it differs from the public code (the client must not learn where a clash came from). */
    public readonly reason?: string,
  ) {
    super(message);
  }
}

export interface SignupInput {
  orgName: string;
  name: string;
  email: string;
  password: string;
  altcha: string;
}

export interface SignupResult {
  slug: string;
  signInUrl: string;
}

export class SignupService {
  private inflight = 0;

  /** `settings` is read on every call, so a test (or an operator through a restart) can change limits. */
  constructor(
    private readonly pool: Pool,
    readonly settings: SignupSettings,
    private readonly identity: SignupIdentity | null,
    private readonly now: () => number = Date.now,
  ) {}

  challenge(): AltchaChallenge {
    return createChallenge(this.settings.captchaSecret, this.now(), this.settings.maxNumber);
  }

  /** The hash that identifies a client address in the database (keyed, so the table alone does not reveal addresses). */
  ipHash(ip: string): string {
    return createHmac('sha256', this.settings.ipHashKey).update(ipKey(ip)).digest('hex').slice(0, 32);
  }

  async signup(input: SignupInput, ip: string): Promise<SignupResult> {
    const s = this.settings;
    const email = input.email.trim().toLowerCase();
    const domain = emailDomain(email);
    const ipHash = this.ipHash(ip);

    const refuse = async (status: number, code: string, message: string, retryAfter?: number, reason?: string): Promise<never> => {
      await this.event('refusal', reason ?? code, ipHash, domain);
      throw new SignupError(status, code, message, retryAfter, reason);
    };

    if (!s.enabled || !this.identity) throw new SignupError(503, 'signup_unavailable', 'sign-up is not available right now');

    // 1. Proof of work: a valid, unexpired solution of a challenge this server issued, used once.
    const check = inspectSolution(input.altcha, s.captchaSecret, this.now());
    if (!check.ok) {
      return refuse(400, check.reason === 'expired' ? 'captcha_expired' : 'captcha_invalid', 'the captcha was not accepted, please try again');
    }
    const fresh = await this.pool.query('SELECT altcha_consume($1) AS fresh', [createHash('sha256').update(check.challenge).digest('hex')]);
    if (!fresh.rows[0]?.fresh) return refuse(400, 'captcha_replayed', 'the captcha was already used, please try again');

    // 2. Throwaway mailboxes.
    if (isDisposable(email, s.blockedDomains)) return refuse(422, 'disposable_email', 'please use a permanent work or personal email address');

    // 3. Abuse limits (kept in the database, so they hold across API instances); a passing attempt is recorded atomically.
    const admit = (
      await this.pool.query('SELECT allowed, reason, retry_after FROM signup_admit($1, $2, $3, $4, $5)', [
        ipHash,
        domain,
        s.ipPerHour,
        domainLimit(domain, s.domainPerHour),
        s.dailyCap,
      ])
    ).rows[0] as { allowed: boolean; reason: string; retry_after: number };
    if (!admit.allowed) {
      if (admit.reason === 'daily_cap') return refuse(503, 'daily_cap', 'new trials are paused for today, please try again later', admit.retry_after);
      return refuse(429, 'rate_limited', 'too many sign-ups, please try again later', admit.retry_after);
    }

    // 4. Create everything or nothing. The transaction stays open across the identity-provider call on purpose: if that
    //    call fails, the organization, licence and mailbox record disappear with the rollback.
    if (this.inflight >= s.maxConcurrent) return refuse(503, 'busy', 'the service is busy, please try again in a moment', 5);
    this.inflight += 1;
    try {
      const slug = await this.create(input, email, domain, ipHash, refuse);
      await this.event('success', '', ipHash, domain, slug);
      return { slug, signInUrl: '/app' };
    } finally {
      this.inflight -= 1;
    }
  }

  private async create(
    input: SignupInput,
    email: string,
    domain: string,
    ipHash: string,
    refuse: (status: number, code: string, message: string, retryAfter?: number, reason?: string) => Promise<never>,
  ): Promise<string> {
    const emailHash = createHash('sha256').update(normalizeEmail(email)).digest('hex');
    const client = await this.pool.connect();
    let kcId: string | null = null;
    let slug: string | null = null;
    let ambiguous = false;
    try {
      await client.query('BEGIN');
      let org: { org_id: string; slug: string };
      try {
        org = (
          await client.query('SELECT org_id, slug FROM create_trial_org($1, $2, $3, $4, $5, $6, $7)', [
            slugify(input.orgName),
            input.orgName,
            emailHash,
            ipHash,
            TRIAL.days,
            TRIAL.participants,
            TRIAL.minutes,
          ])
        ).rows[0];
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new SignupError(409, 'email_taken', 'this email is already registered, sign in instead');
        throw e;
      }
      slug = org.slug;

      try {
        kcId = (await this.identity!.createOrgAdmin({ email, name: input.name.trim(), orgSlug: slug, password: input.password })).id;
      } catch (e) {
        if (e instanceof IdentityAdminError && e.status === 409) {
          throw new SignupError(409, 'email_taken', 'this email is already registered, sign in instead', undefined, 'identity_email_taken');
        }
        if (e instanceof IdentityAdminError && e.status === 400) {
          throw new SignupError(422, 'identity_rejected', 'the email or password was rejected, please check them');
        }
        ambiguous = true; // the request may have reached the provider even though we saw a failure
        throw new SignupError(503, 'identity_unavailable', 'the sign-in service is not reachable, please try again', 10);
      }

      await this.finishInTenant(client, org.org_id, kcId, email, input.name.trim(), slug);
      await client.query('COMMIT');
      return slug;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      // Remove what the identity provider may hold. Both are best effort: a failure here cannot change the answer.
      if (kcId) await this.identity!.deleteUser(kcId).catch(() => undefined);
      else if (ambiguous && slug) await this.identity!.deleteOrgAdminByEmail(email, slug).catch(() => undefined);
      if (e instanceof SignupError) return refuse(e.status, e.code, e.message, e.retryAfter, e.reason);
      return refuse(503, 'signup_failed', 'sign-up could not be completed, please try again', 10);
    } finally {
      client.release();
    }
  }

  /** Inside the same transaction: the user row (so the first sign-in needs no provisioning) and the audit row. */
  private async finishInTenant(c: PoolClient, orgId: string, sub: string, email: string, name: string, slug: string): Promise<void> {
    await c.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
    const u = await c.query(
      `INSERT INTO users (org_id, external_sub, email, display_name, role) VALUES ($1, $2, $3, $4, 'org_admin') RETURNING id`,
      [orgId, sub, email, name],
    );
    await c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [orgId, u.rows[0].id, 'signup.trial', slug]);
  }

  private async event(kind: 'refusal' | 'success', reason: string, ipHash: string, domain: string, slug: string | null = null): Promise<void> {
    try {
      await this.pool.query('SELECT signup_event_add($1, $2, $3, $4, $5)', [kind, reason, ipHash, domain, slug]);
    } catch {
      /* the audit write must never change the answer given to the caller */
    }
  }
}
