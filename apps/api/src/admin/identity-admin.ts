import { randomInt } from 'node:crypto';
import type { PrivacyIdentity } from '../privacy/ports.js';

export type OrgRole = 'org_admin' | 'member';

/** Failure of the identity provider; `status` is the HTTP status to answer with. Never carries request bodies. */
export class IdentityAdminError extends Error {
  constructor(public readonly status: 409 | 400 | 502 | 503, message: string) {
    super(message);
  }
}

export interface NewIdentityUser {
  email: string;
  firstName: string;
  lastName: string;
  orgSlug: string;
  role: OrgRole;
  requireTotp: boolean;
  temporaryPassword: string;
}

/** A trial organization's first administrator, created by the public sign-up (permanent password, no required actions). */
export interface NewOrgAdmin {
  email: string;
  name: string;
  orgSlug: string;
  password: string;
  /** The language the person signed up in: Keycloak writes its emails (verification, reset) in the account's locale. */
  locale?: 'uz' | 'ru' | 'en';
}

/** Removes the identity-provider users of a purged organization (personal data must not outlive the trial). */
export interface OrgUserCleaner {
  deleteUsersByOrgSlug(orgSlug: string): Promise<void>;
}

/** The part of the identity provider the public sign-up needs. Keycloak implements it; tests use a fake. */
export interface SignupIdentity {
  /** Creates the user with the org_slug attribute and the org_admin + member realm roles. Throws IdentityAdminError. */
  createOrgAdmin(u: NewOrgAdmin): Promise<{ id: string }>;
  deleteUser(sub: string): Promise<void>;
  /** Best-effort cleanup after an ambiguous failure: deletes the user with this email ONLY if it carries this org_slug. */
  deleteOrgAdminByEmail(email: string, orgSlug: string): Promise<void>;
}

/** What the provider knows about a signed-in account that has no organization yet (first sign-in through Google/Microsoft). */
export interface BrokeredAccount {
  email: string;
  emailVerified: boolean;
  orgSlug: string | null;
  /** Linked identity providers (google, microsoft, ...); empty for a password-only account. */
  providers: string[];
}

/** Email verification and first-sign-in organization set-up. Keycloak implements it; tests use a fake. */
/** Self-service security of the profile page (owner decision 3): what the identity provider knows about one account. */
export interface SelfServiceIdentity {
  credentials(sub: string): Promise<Array<{ id: string; type: string; label: string | null; createdAt: string | null }>>;
  sessions(sub: string): Promise<Array<{ id: string; ip: string | null; start: string | null; lastAccess: string | null }>>;
  endSession(sub: string, sid: string): Promise<boolean>;
  endAllSessions(sub: string): Promise<void>;
  links(sub: string): Promise<Array<{ provider: string; userName: string | null }>>;
  unlink(sub: string, provider: string): Promise<void>;
  signInProviders(): Promise<SignInProvider[]>;
}

export interface OnboardingIdentity {
  /** Sends the "verify your email" message; `redirectUri` is where the link lands afterwards. Throws IdentityAdminError (503 = mail not sent). */
  sendVerifyEmail(sub: string, redirectUri: string | null): Promise<void>;
  /** The provider's current answer (the token may be older than the click on the link). */
  emailVerified(sub: string): Promise<boolean>;
  account(sub: string): Promise<BrokeredAccount | null>;
  /** Puts an organization-less account into an organization as its administrator (attribute + org_admin and member roles). */
  attachOrgAdmin(sub: string, orgSlug: string, locale?: 'uz' | 'ru' | 'en'): Promise<void>;
  /** Undoes attachOrgAdmin after a failed transaction (best effort by the caller). */
  detachOrg(sub: string, orgSlug: string): Promise<void>;
  /** The external sign-in providers that are configured, enabled and shown (only the ones the product supports). */
  signInProviders(): Promise<SignInProvider[]>;
  /** Whether the realm has a mail server (otherwise "send the verification link" cannot work). */
  canSendEmail(): Promise<boolean>;
}

export const SIGN_IN_PROVIDERS = ['google', 'microsoft'] as const;
export type SignInProvider = (typeof SIGN_IN_PROVIDERS)[number];

/**
 * The part of the identity provider the admin console needs. Keycloak implements it; unit tests use a fake.
 * Methods that address an existing user take the provider's subject id and the organization slug the caller
 * belongs to: an implementation must refuse (return false / not touch) users that belong to another organization.
 */
export interface IdentityAdmin {
  /** Creates the user with the org_slug attribute, realm role and required actions. Returns the provider subject id. */
  createUser(u: NewIdentityUser): Promise<{ id: string }>;
  /** Applies role and/or enabled flag. Returns false when the user does not exist in the provider (nothing to sync). */
  updateUser(sub: string, orgSlug: string, patch: { role?: OrgRole; enabled?: boolean }): Promise<boolean>;
  deleteUser(sub: string): Promise<void>;
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT = '23456789';
const SYMBOL = '-_.!#%';

/** 20-character temporary password from a CSPRNG with at least one character of every class. */
export function generateTemporaryPassword(): string {
  const pick = (set: string) => set[randomInt(0, set.length)]!;
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  const all = UPPER + LOWER + DIGIT + SYMBOL;
  while (chars.length < 20) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

interface KcConfig {
  baseUrl: string; // e.g. http://host:8180/auth
  realm: string;
  clientId: string;
  clientSecret: string;
  /** Per-request limit; default 10 s. */
  timeoutMs?: number;
}

interface KcUser {
  id?: string;
  enabled?: boolean;
  attributes?: Record<string, string[]>;
  [k: string]: unknown;
}

const TIMEOUT_MS = 10_000;

/** Keycloak admin REST API client, authenticated as a confidential service account (client_credentials). */
export class KeycloakAdmin implements IdentityAdmin, SignupIdentity, OrgUserCleaner, PrivacyIdentity, OnboardingIdentity, SelfServiceIdentity {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly base: string;

  private readonly timeoutMs: number;

  constructor(private readonly cfg: KcConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = cfg.timeoutMs ?? TIMEOUT_MS;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;
    let res: Response;
    try {
      res = await fetch(`${this.base}/realms/${encodeURIComponent(this.cfg.realm)}/protocol/openid-connect/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.cfg.clientId,
          client_secret: this.cfg.clientSecret,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new IdentityAdminError(502, 'identity provider is unreachable');
    }
    if (!res.ok) throw new IdentityAdminError(502, 'identity provider rejected the admin credentials');
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new IdentityAdminError(502, 'identity provider returned no token');
    this.token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 60) * 1000 };
    return body.access_token;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.accessToken();
    try {
      return await fetch(`${this.base}/admin/realms/${encodeURIComponent(this.cfg.realm)}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new IdentityAdminError(502, 'identity provider is unreachable');
    }
  }

  private async realmRole(name: OrgRole): Promise<{ id: string; name: string }> {
    const res = await this.call('GET', `/roles/${name}`);
    if (!res.ok) throw new IdentityAdminError(502, `identity provider has no realm role ${name}`);
    return (await res.json()) as { id: string; name: string };
  }

  private async setRole(id: string, role: OrgRole): Promise<void> {
    // Every user keeps `member`; `org_admin` is added or removed on top (token claims treat org_admin as the stronger role).
    const member = await this.realmRole('member');
    const admin = await this.realmRole('org_admin');
    const add = await this.call('POST', `/users/${id}/role-mappings/realm`, role === 'org_admin' ? [member, admin] : [member]);
    if (!add.ok) throw new IdentityAdminError(502, 'identity provider refused the role change');
    if (role === 'member') {
      const del = await this.call('DELETE', `/users/${id}/role-mappings/realm`, [admin]);
      if (!del.ok) throw new IdentityAdminError(502, 'identity provider refused the role change');
    }
  }

  async createUser(u: NewIdentityUser): Promise<{ id: string }> {
    const requiredActions = ['UPDATE_PASSWORD', ...(u.requireTotp || u.role === 'org_admin' ? ['CONFIGURE_TOTP'] : [])];
    const res = await this.call('POST', '/users', {
      username: u.email.toLowerCase(),
      email: u.email,
      firstName: u.firstName,
      lastName: u.lastName,
      enabled: true,
      emailVerified: false,
      attributes: { org_slug: [u.orgSlug] },
      requiredActions,
      credentials: [{ type: 'password', value: u.temporaryPassword, temporary: true }],
    });
    if (res.status === 409) throw new IdentityAdminError(409, 'a user with this email already exists');
    if (res.status === 400) throw new IdentityAdminError(400, 'identity provider rejected the user data');
    if (res.status !== 201) throw new IdentityAdminError(502, 'identity provider could not create the user');
    const id = res.headers.get('location')?.split('/').pop();
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new IdentityAdminError(502, 'identity provider returned no user id');
    try {
      await this.setRole(id, u.role);
    } catch (e) {
      await this.deleteUser(id).catch(() => undefined); // do not leave a user without a role behind
      throw e;
    }
    return { id };
  }

  async createOrgAdmin(u: NewOrgAdmin): Promise<{ id: string }> {
    const [firstName = '', ...rest] = u.name.trim().split(/\s+/);
    const res = await this.call('POST', '/users', {
      username: u.email.toLowerCase(),
      email: u.email,
      firstName,
      lastName: rest.join(' '),
      enabled: true,
      emailVerified: false, // verified later through the link the product sends (nothing is blocked meanwhile)
      attributes: { org_slug: [u.orgSlug], ...(u.locale ? { locale: [u.locale] } : {}) },
      credentials: [{ type: 'password', value: u.password, temporary: false }],
    });
    if (res.status === 409) throw new IdentityAdminError(409, 'a user with this email already exists');
    if (res.status === 400) throw new IdentityAdminError(400, 'identity provider rejected the user data');
    if (res.status !== 201) throw new IdentityAdminError(502, 'identity provider could not create the user');
    const id = res.headers.get('location')?.split('/').pop();
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) throw new IdentityAdminError(502, 'identity provider returned no user id');
    try {
      await this.setRole(id, 'org_admin');
    } catch (e) {
      await this.deleteUser(id).catch(() => undefined); // do not leave a user without a role behind
      throw e;
    }
    return { id };
  }

  async deleteOrgAdminByEmail(email: string, orgSlug: string): Promise<void> {
    const res = await this.call('GET', `/users?email=${encodeURIComponent(email)}&exact=true`);
    if (!res.ok) return;
    const users = (await res.json()) as KcUser[];
    for (const user of users) {
      // The slug of a sign-up in progress belongs to exactly one attempt, so this can never hit somebody else's account.
      if (user.id && user.attributes?.['org_slug']?.[0] === orgSlug) await this.deleteUser(user.id);
    }
  }

  async deleteUsersByOrgSlug(orgSlug: string): Promise<void> {
    const res = await this.call('GET', `/users?q=${encodeURIComponent(`org_slug:${orgSlug}`)}&max=200`);
    if (!res.ok) throw new IdentityAdminError(502, 'identity provider could not list the users');
    for (const user of (await res.json()) as KcUser[]) {
      if (user.id && user.attributes?.['org_slug']?.[0] === orgSlug) await this.deleteUser(user.id);
    }
  }

  async updateUser(sub: string, orgSlug: string, patch: { role?: OrgRole; enabled?: boolean }): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(sub)) return false; // not a Keycloak id (e.g. a placeholder subject): nothing to sync
    const get = await this.call('GET', `/users/${sub}`);
    if (get.status === 404) return false;
    if (!get.ok) throw new IdentityAdminError(502, 'identity provider could not read the user');
    const user = (await get.json()) as KcUser;
    // Defence in depth: never touch a provider account that belongs to another organization.
    if (user.attributes?.['org_slug']?.[0] !== orgSlug) return false;
    if (patch.enabled !== undefined && user.enabled !== patch.enabled) {
      // Full representation round-trip: a partial PUT could drop attributes under the declarative user profile.
      const put = await this.call('PUT', `/users/${sub}`, { ...user, enabled: patch.enabled });
      if (!put.ok) throw new IdentityAdminError(502, 'identity provider refused the update');
      if (!patch.enabled) await this.call('POST', `/users/${sub}/logout`); // end live sessions; best effort
    }
    if (patch.role) await this.setRole(sub, patch.role);
    return true;
  }

  /**
   * Erasure of a person (privacy/privacy.service.ts): ends every session, then deletes the account. Repeatable (a missing user
   * is success). Refuses an account that carries another organization's slug. A subject that is not a provider id has no
   * provider account (a placeholder subject in tests) and is skipped.
   */
  async eraseUser(sub: string, orgSlug: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(sub)) return;
    const get = await this.call('GET', `/users/${sub}`);
    if (get.status === 404) return;
    if (!get.ok) throw new IdentityAdminError(502, 'identity provider could not read the user');
    const user = (await get.json()) as KcUser;
    if (user.attributes?.['org_slug']?.[0] !== orgSlug) throw new IdentityAdminError(502, 'identity provider account belongs to another organization');
    const out = await this.call('POST', `/users/${sub}/logout`);
    if (!out.ok && out.status !== 404) throw new IdentityAdminError(502, 'identity provider could not end the sessions');
    await this.deleteUser(sub);
  }

  async sendVerifyEmail(sub: string, redirectUri: string | null): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(sub)) throw new IdentityAdminError(400, 'not a provider account');
    const q = new URLSearchParams({ client_id: 'davrabox-web', ...(redirectUri ? { redirect_uri: redirectUri } : {}) });
    const res = await this.call('PUT', `/users/${sub}/send-verify-email?${q}`);
    // Keycloak answers 500 when its mail server refused or is not configured: the message did not leave.
    if (res.status === 404) throw new IdentityAdminError(400, 'no such account');
    if (!res.ok) throw new IdentityAdminError(503, 'the verification email could not be sent');
  }

  async emailVerified(sub: string): Promise<boolean> {
    return (await this.account(sub))?.emailVerified ?? false;
  }

  async account(sub: string): Promise<BrokeredAccount | null> {
    if (!/^[0-9a-f-]{36}$/i.test(sub)) return null;
    const get = await this.call('GET', `/users/${sub}`);
    if (get.status === 404) return null;
    if (!get.ok) throw new IdentityAdminError(502, 'identity provider could not read the user');
    const user = (await get.json()) as KcUser & { email?: string; emailVerified?: boolean };
    const fed = await this.call('GET', `/users/${sub}/federated-identity`);
    if (!fed.ok) throw new IdentityAdminError(502, 'identity provider could not read the linked accounts');
    const links = (await fed.json()) as Array<{ identityProvider?: string }>;
    return {
      email: user.email ?? '',
      emailVerified: user.emailVerified === true,
      orgSlug: user.attributes?.['org_slug']?.[0] ?? null,
      providers: links.map((l) => l.identityProvider ?? '').filter(Boolean),
    };
  }

  async attachOrgAdmin(sub: string, orgSlug: string, locale?: 'uz' | 'ru' | 'en'): Promise<void> {
    const get = await this.call('GET', `/users/${sub}`);
    if (!get.ok) throw new IdentityAdminError(502, 'identity provider could not read the user');
    const user = (await get.json()) as KcUser;
    const current = user.attributes?.['org_slug']?.[0];
    if (current && current !== orgSlug) throw new IdentityAdminError(409, 'the account already belongs to an organization');
    // Full representation round-trip: a partial PUT could drop attributes under the declarative user profile.
    const attributes = { ...(user.attributes ?? {}), org_slug: [orgSlug], ...(locale && !user.attributes?.['locale'] ? { locale: [locale] } : {}) };
    const put = await this.call('PUT', `/users/${sub}`, { ...user, attributes });
    if (!put.ok) throw new IdentityAdminError(502, 'identity provider refused the update');
    await this.setRole(sub, 'org_admin');
  }

  async canSendEmail(): Promise<boolean> {
    const res = await this.call('GET', '');
    if (!res.ok) throw new IdentityAdminError(502, 'identity provider could not read the realm');
    const realm = (await res.json()) as { smtpServer?: { host?: string } };
    return Boolean(realm.smtpServer?.host);
  }

  async signInProviders(): Promise<SignInProvider[]> {
    const res = await this.call('GET', '/identity-provider/instances');
    if (!res.ok) throw new IdentityAdminError(502, 'identity provider could not list the sign-in providers');
    const list = (await res.json()) as Array<{ alias?: string; enabled?: boolean; config?: Record<string, string> }>;
    return SIGN_IN_PROVIDERS.filter((a) => list.some((p) => p.alias === a && p.enabled !== false && p.config?.['hideOnLogin'] !== 'true'));
  }

  async detachOrg(sub: string, orgSlug: string): Promise<void> {
    const get = await this.call('GET', `/users/${sub}`);
    if (!get.ok) return;
    const user = (await get.json()) as KcUser;
    if (user.attributes?.['org_slug']?.[0] !== orgSlug) return; // never touch an account another organization holds
    const { org_slug: _drop, ...rest } = user.attributes ?? {};
    await this.call('PUT', `/users/${sub}`, { ...user, attributes: rest });
    const roles = await Promise.all([this.realmRole('org_admin'), this.realmRole('member')]);
    await this.call('DELETE', `/users/${sub}/role-mappings/realm`, roles);
  }

  async deleteUser(sub: string): Promise<void> {
    const res = await this.call('DELETE', `/users/${sub}`);
    if (!res.ok && res.status !== 404) throw new IdentityAdminError(502, 'identity provider could not delete the user');
  }
  // --- self-service security (profile page) ------------------------------------------------------------------

  async credentials(sub: string): Promise<Array<{ id: string; type: string; label: string | null; createdAt: string | null }>> {
    if (!/^[0-9a-f-]{36}$/i.test(sub)) return [];
    const res = await this.call('GET', `/users/${sub}/credentials`);
    if (!res.ok) throw new IdentityAdminError(502, 'identity provider could not list the sign-in methods');
    const list = (await res.json()) as Array<{ id?: string; type?: string; userLabel?: string; createdDate?: number }>;
    return list
      .filter((c) => c.id && c.type)
      .map((c) => ({ id: c.id!, type: c.type!, label: c.userLabel ?? null, createdAt: c.createdDate ? new Date(c.createdDate).toISOString() : null }));
  }

  async sessions(sub: string): Promise<Array<{ id: string; ip: string | null; start: string | null; lastAccess: string | null }>> {
    if (!/^[0-9a-f-]{36}$/i.test(sub)) return [];
    const res = await this.call('GET', `/users/${sub}/sessions`);
    if (!res.ok) throw new IdentityAdminError(502, 'identity provider could not list the sessions');
    const list = (await res.json()) as Array<{ id?: string; ipAddress?: string; start?: number; lastAccess?: number }>;
    return list
      .filter((x) => x.id)
      .map((x) => ({ id: x.id!, ip: x.ipAddress ?? null, start: x.start ? new Date(x.start).toISOString() : null, lastAccess: x.lastAccess ? new Date(x.lastAccess).toISOString() : null }));
  }

  /** Ends one session of this account only (a session id of somebody else is refused). */
  async endSession(sub: string, sid: string): Promise<boolean> {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(sid)) return false;
    const own = await this.sessions(sub);
    if (!own.some((x) => x.id === sid)) return false;
    const res = await this.call('DELETE', `/sessions/${encodeURIComponent(sid)}`);
    if (!res.ok && res.status !== 404) throw new IdentityAdminError(502, 'identity provider could not end the session');
    return true;
  }

  async endAllSessions(sub: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(sub)) return;
    const res = await this.call('POST', `/users/${sub}/logout`);
    if (!res.ok) throw new IdentityAdminError(502, 'identity provider could not end the sessions');
  }

  async links(sub: string): Promise<Array<{ provider: string; userName: string | null }>> {
    if (!/^[0-9a-f-]{36}$/i.test(sub)) return [];
    const res = await this.call('GET', `/users/${sub}/federated-identity`);
    if (!res.ok) throw new IdentityAdminError(502, 'identity provider could not read the linked accounts');
    const list = (await res.json()) as Array<{ identityProvider?: string; userName?: string }>;
    return list.filter((l) => l.identityProvider).map((l) => ({ provider: l.identityProvider!, userName: l.userName ?? null }));
  }

  async unlink(sub: string, provider: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(sub) || !/^[a-z0-9-]{1,40}$/.test(provider)) throw new IdentityAdminError(400, 'invalid provider');
    const res = await this.call('DELETE', `/users/${sub}/federated-identity/${provider}`);
    if (!res.ok && res.status !== 404) throw new IdentityAdminError(502, 'identity provider could not remove the link');
  }
}
