import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface Identity {
  sub: string;
  email: string;
  name: string;
  orgSlug: string;
  role: 'org_admin' | 'member';
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
  return { sub, email, name, orgSlug, role };
}

export function createVerifier(issuer: string, audience: string) {
  const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));
  return async (token: string): Promise<Identity> => {
    // Keycloak access tokens carry the client in azp; audience is enforced via azp below.
    const { payload } = await jwtVerify(token, jwks, { issuer, algorithms: ['RS256'], clockTolerance: 5 });
    if (payload['azp'] !== audience) throw new Error('token was not issued for this client');
    return identityFromClaims(payload);
  };
}
