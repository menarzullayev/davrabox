import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface Identity {
  sub: string;
  email: string;
  name: string;
  orgSlug: string;
  role: 'org_admin' | 'member';
  /** The token's email_verified claim (may be older than the click on the verification link). */
  emailVerified?: boolean;
  /** The identity provider's session id (`sid`): "Where you're signed in" ties a device to it. */
  sid?: string;
}

/** A signed-in account that has no organization yet: the first sign-in through Google or Microsoft. */
export interface PendingIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string;
  /** Empty when the account has no organization. */
  orgSlug: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

/** Maps verified token claims to an Identity or throws. Never trusts unverified input. */
export function identityFromClaims(p: JWTPayload): Identity {
  const sub = typeof p.sub === 'string' ? p.sub : '';
  const email = typeof p.email === 'string' ? p.email : '';
  const orgSlug = typeof p['org_slug'] === 'string' ? (p['org_slug'] as string) : '';
  const realmAccess = p['realm_access'] as { roles?: unknown } | undefined;
  const roles = Array.isArray(realmAccess?.roles) ? (realmAccess!.roles as unknown[]) : [];
  if (!sub || !email) throw new Error('token lacks subject or email');
  if (!SLUG_RE.test(orgSlug)) throw new Error('token lacks a valid organization');
  const role = roles.includes('org_admin') ? 'org_admin' : roles.includes('member') ? 'member' : null;
  if (!role) throw new Error('token lacks a DavraBox role');
  const name = typeof p['name'] === 'string' ? (p['name'] as string) : email;
  const sid = typeof p['sid'] === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(p['sid'] as string) ? (p['sid'] as string) : undefined;
  return { sub, email, name, orgSlug, role, emailVerified: p['email_verified'] === true, ...(sid ? { sid } : {}) };
}

/** Like identityFromClaims, but an organization and a role are not required (used only by the organization set-up). */
export function pendingIdentityFromClaims(p: JWTPayload): PendingIdentity {
  const sub = typeof p.sub === 'string' ? p.sub : '';
  const email = typeof p.email === 'string' ? p.email : '';
  if (!sub || !email) throw new Error('token lacks subject or email');
  const raw = typeof p['org_slug'] === 'string' ? (p['org_slug'] as string) : '';
  const name = typeof p['name'] === 'string' && (p['name'] as string).trim() ? (p['name'] as string).trim() : '';
  return { sub, email, emailVerified: p['email_verified'] === true, name, orgSlug: SLUG_RE.test(raw) ? raw : '' };
}

/** Verifies signature, issuer and client; returns the raw claims. */
export function createTokenVerifier(issuers: string[], audience: string, jwksUrl?: string) {
  const jwks = createRemoteJWKSet(new URL(jwksUrl ?? `${issuers[0]}/protocol/openid-connect/certs`));
  return async (token: string): Promise<JWTPayload> => {
    // Keycloak access tokens carry the client in azp; audience is enforced via azp below.
    const { payload } = await jwtVerify(token, jwks, { issuer: issuers, algorithms: ['RS256'], clockTolerance: 5 });
    if (payload['azp'] !== audience) throw new Error('token was not issued for this client');
    return payload;
  };
}

export function createVerifier(issuers: string[], audience: string, jwksUrl?: string) {
  const verify = createTokenVerifier(issuers, audience, jwksUrl);
  return async (token: string): Promise<Identity> => identityFromClaims(await verify(token));
}

export function createPendingVerifier(issuers: string[], audience: string, jwksUrl?: string) {
  const verify = createTokenVerifier(issuers, audience, jwksUrl);
  return async (token: string): Promise<PendingIdentity> => pendingIdentityFromClaims(await verify(token));
}
