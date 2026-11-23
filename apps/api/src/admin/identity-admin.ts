import { randomInt } from 'node:crypto';

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
}

/** The part of the identity provider the public sign-up needs. Keycloak implements it; tests use a fake. */
export interface SignupIdentity {
  /** Creates the user with the org_slug attribute and the org_admin + member realm roles. Throws IdentityAdminError. */
  createOrgAdmin(u: NewOrgAdmin): Promise<{ id: string }>;
  deleteUser(sub: string): Promise<void>;
  /** Best-effort cleanup after an ambiguous failure: deletes the user with this email ONLY if it carries this org_slug. */
  deleteOrgAdminByEmail(email: string, orgSlug: string): Promise<void>;
}

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
}

interface KcUser {
  id?: string;
  enabled?: boolean;
  attributes?: Record<string, string[]>;
  [k: string]: unknown;
}

const TIMEOUT_MS = 10_000;

/** Keycloak admin REST API client, authenticated as a confidential service account (client_credentials). */
export class KeycloakAdmin implements IdentityAdmin, SignupIdentity {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly base: string;

  constructor(private readonly cfg: KcConfig) {
    this.base = cfg.baseUrl.replace(/\/+$/, '');
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
        signal: AbortSignal.timeout(TIMEOUT_MS),
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
        signal: AbortSignal.timeout(TIMEOUT_MS),
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
      emailVerified: false, // no email is ever sent by the product, so nothing verifies it
      attributes: { org_slug: [u.orgSlug] },
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

  async deleteUser(sub: string): Promise<void> {
    const res = await this.call('DELETE', `/users/${sub}`);
    if (!res.ok && res.status !== 404) throw new IdentityAdminError(502, 'identity provider could not delete the user');
  }
}
