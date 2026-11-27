import { createHash, createHmac } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { IdentityAdminError, type NewOrgAdmin, type OnboardingIdentity, type SignInProvider, type SignupIdentity } from '../admin/identity-admin.js';
import type { PendingIdentity } from '../auth/jwt.js';
import { createChallenge, inspectSolution, type AltchaChallenge } from './altcha.js';
import { isDisposable } from './disposable-domains.js';
import { emailDomain, normalizeEmail } from './email-normalize.js';
import { domainLimit, ipKey, TRIAL, type SignupSettings } from './limits.js';
import { slugify } from './slug.js';
import { signupRefusals, signupSuccess } from '../metrics.js';

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
  /** Optional: without it the organization is named after the person. */
  orgName?: string;
  name: string;
  email: string;
  password: string;
  altcha: string;
  /** The page language; the account's emails use it. */
  lang?: 'uz' | 'ru' | 'en';
}

export interface SignupResult {
  slug: string;
  signInUrl: string;
}

/** The organization name to use: the one typed, else the person's name (the database needs at least two characters). */
export function orgNameFor(orgName: string | undefined, name: string): string {
  const typed = orgName?.trim() ?? '';
  if (typed.length >= 2) return typed;
  const fallback = name.trim();
  return fallback.length >= 2 ? fallback : `${fallback || 'DavraBox'} team`;
}

export class SignupService {
  private inflight = 0;
  private providersCache: { at: number; value: SignInProvider[] } | null = null;

  /** `settings` is read on every call, so a test (or an operator through a restart) can change limits. */
  constructor(
    private readonly pool: Pool,
    readonly settings: SignupSettings,
    private readonly identity: (SignupIdentity & Partial<OnboardingIdentity>) | null,
    private readonly now: () => number = Date.now,
  ) {}

  /** Full onboarding support (email verification, first sign-in through Google/Microsoft), when the provider offers it. */
  private get onboarding(): OnboardingIdentity | null {
    const i = this.identity;
    return i && i.sendVerifyEmail && i.account && i.attachOrgAdmin && i.detachOrg && i.emailVerified && i.signInProviders ? (i as OnboardingIdentity) : null;
  }

  /**
   * The external sign-in buttons the sign-up page may show: only providers really configured in the realm (cached for a
   * minute; an unreachable provider list means no buttons, never an error on the public page).
   */
  async signInOptions(): Promise<{ providers: SignInProvider[] }> {
    const kc = this.onboarding;
    if (!this.settings.enabled || !kc) return { providers: [] };
    const now = this.now();
    if (this.providersCache && now - this.providersCache.at < 60_000) return { providers: this.providersCache.value };
    let value: SignInProvider[] = [];
    try {
      value = await kc.signInProviders();
    } catch {
      value = [];
    }
    this.providersCache = { at: now, value };
    return { providers: value };
  }

  challenge(): AltchaChallenge {
    return createChallenge(this.settings.captchaSecret, this.now(), this.settings.maxNumber);
  }

  /** The hash that identifies a client address in the database (keyed, so the table alone does not reveal addresses). */
  ipHash(ip: string): string {
    return createHmac('sha256', this.settings.ipHashKey).update(ipKey(ip)).digest('hex').slice(0, 32);
  }

  /** `verifyRedirect`: where the link in the verification email lands (the application on the host the visitor used). */
  async signup(input: SignupInput, ip: string, verifyRedirect: string | null = null): Promise<SignupResult> {
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
      const { slug, sub } = await this.create(input, email, domain, ipHash, refuse);
      await this.event('success', '', ipHash, domain, slug);
      // Decision 2 (2026-11-27): the organization opens at once; the verification email goes out now and nothing waits for it.
      // Best effort: a mail failure never undoes the sign-up (the home screen offers "send again").
      const kc = this.onboarding;
      if (kc) void kc.sendVerifyEmail(sub, verifyRedirect).catch(() => undefined);
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
  ): Promise<{ slug: string; sub: string }> {
    const emailHash = createHash('sha256').update(normalizeEmail(email)).digest('hex');
    const orgName = orgNameFor(input.orgName, input.name);
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
            slugify(orgName),
            orgName,
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
        kcId = (await this.identity!.createOrgAdmin({ email, name: input.name.trim(), orgSlug: slug, password: input.password, ...(input.lang ? { locale: input.lang } : {}) })).id;
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
      return { slug, sub: kcId };
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

  /**
   * First sign-in through Google or Microsoft (decision 4): the provider created an account without an organization; this
   * opens a trial organization with that person as its administrator. The same abuse limits as the form apply (minus the
   * proof of work: the external account already cost the visitor a sign-in). Only an account that has no organization and is
   * linked to an external provider qualifies; invited people already carry their organization and never come here.
   */
  async setupOrganization(who: PendingIdentity, orgName: string | undefined, ip: string, lang?: 'uz' | 'ru' | 'en'): Promise<SignupResult> {
    const s = this.settings;
    const email = who.email.trim().toLowerCase();
    const domain = emailDomain(email);
    const ipHash = this.ipHash(ip);
    const refuse = async (status: number, code: string, message: string, retryAfter?: number, reason?: string): Promise<never> => {
      await this.event('refusal', reason ?? code, ipHash, domain);
      throw new SignupError(status, code, message, retryAfter, reason);
    };
    const kc = this.onboarding;
    if (!s.enabled || !kc) throw new SignupError(503, 'signup_unavailable', 'sign-up is not available right now');
    if (who.orgSlug) throw new SignupError(409, 'already_member', 'this account already belongs to an organization');

    let account: Awaited<ReturnType<OnboardingIdentity['account']>>;
    try {
      account = await kc.account(who.sub);
    } catch {
      throw new SignupError(503, 'identity_unavailable', 'the sign-in service is not reachable, please try again', 10);
    }
    if (!account) throw new SignupError(403, 'no_account', 'the account was not found');
    if (account.orgSlug) throw new SignupError(409, 'already_member', 'this account already belongs to an organization');
    if (account.providers.length === 0) return refuse(403, 'not_external', 'only a first sign-in through Google or Microsoft sets up an organization here');
    if (isDisposable(email, s.blockedDomains)) return refuse(422, 'disposable_email', 'please use a permanent work or personal email address');

    const admit = (
      await this.pool.query('SELECT allowed, reason, retry_after FROM signup_admit($1, $2, $3, $4, $5)', [ipHash, domain, s.ipPerHour, domainLimit(domain, s.domainPerHour), s.dailyCap])
    ).rows[0] as { allowed: boolean; reason: string; retry_after: number };
    if (!admit.allowed) {
      if (admit.reason === 'daily_cap') return refuse(503, 'daily_cap', 'new trials are paused for today, please try again later', admit.retry_after);
      return refuse(429, 'rate_limited', 'too many sign-ups, please try again later', admit.retry_after);
    }
    if (this.inflight >= s.maxConcurrent) return refuse(503, 'busy', 'the service is busy, please try again in a moment', 5);
    this.inflight += 1;
    const name = who.name || email.split('@')[0]!;
    const finalName = orgNameFor(orgName, name);
    const emailHash = createHash('sha256').update(normalizeEmail(email)).digest('hex');
    const providers = account.providers.join('+');
    const client = await this.pool.connect();
    let slug: string | null = null;
    let attached = false;
    try {
      await client.query('BEGIN');
      let org: { org_id: string; slug: string };
      try {
        org = (
          await client.query('SELECT org_id, slug FROM create_trial_org($1, $2, $3, $4, $5, $6, $7)', [slugify(finalName), finalName, emailHash, ipHash, TRIAL.days, TRIAL.participants, TRIAL.minutes])
        ).rows[0];
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new SignupError(409, 'email_taken', 'this email already had a trial');
        throw e;
      }
      slug = org.slug;
      attached = true; // from here the provider may hold the attribute even if the call below fails: the rollback undoes it
      try {
        await kc.attachOrgAdmin(who.sub, slug, lang);
      } catch (e) {
        if (e instanceof IdentityAdminError && e.status === 409) throw new SignupError(409, 'already_member', 'this account already belongs to an organization');
        throw new SignupError(503, 'identity_unavailable', 'the sign-in service is not reachable, please try again', 10);
      }
      await this.finishInTenant(client, org.org_id, who.sub, email, name, slug, `${slug}:${providers}`);
      await client.query('COMMIT');
      attached = false;
      await this.event('success', '', ipHash, domain, slug);
      return { slug, signInUrl: '/app' };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (attached && slug) await kc.detachOrg(who.sub, slug).catch(() => undefined);
      if (e instanceof SignupError) return refuse(e.status, e.code, e.message, e.retryAfter, e.reason);
      return refuse(503, 'signup_failed', 'sign-up could not be completed, please try again', 10);
    } finally {
      client.release();
      this.inflight -= 1;
    }
  }

  /** Inside the same transaction: the user row (so the first sign-in needs no provisioning) and the audit row. */
  private async finishInTenant(c: PoolClient, orgId: string, sub: string, email: string, name: string, slug: string, target = slug): Promise<void> {
    await c.query("SELECT set_config('app.current_org', $1, true)", [orgId]);
    const u = await c.query(
      `INSERT INTO users (org_id, external_sub, email, display_name, role) VALUES ($1, $2, $3, $4, 'org_admin') RETURNING id`,
      [orgId, sub, email, name],
    );
    await c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [orgId, u.rows[0].id, 'signup.trial', target]);
  }

  private async event(kind: 'refusal' | 'success', reason: string, ipHash: string, domain: string, slug: string | null = null): Promise<void> {
    if (kind === 'refusal') signupRefusals.inc({ reason });
    else signupSuccess.inc();
    try {
      await this.pool.query('SELECT signup_event_add($1, $2, $3, $4, $5)', [kind, reason, ipHash, domain, slug]);
    } catch {
      /* the audit write must never change the answer given to the caller */
    }
  }
}
