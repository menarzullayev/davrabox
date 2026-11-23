// Derives the PRODUCTION realm representation from the development realm (deploy/keycloak/davrabox-realm.json).
// Pure and side-effect free so it is unit-tested (lib/prod-realm.test.mjs). The development realm stays the single
// source of truth; production differs only in what it must NOT contain or allow:
//  - TLS is required for every client except loopback (sslRequired=external), never "none"
//  - no demo users: only the service account the API needs to manage users stays
//  - only the production host is an allowed redirect URI / web origin (no localhost, no other hostnames)
//  - explicit session and token lifetimes, refresh-token rotation with reuse detection, security events recorded

export class ProdRealmError extends Error {}

const HOST_PLACEHOLDER = '${PUBLIC_HOST}';
const SERVICE_ACCOUNT = 'service-account-davrabox-admin-api';

export const PROD_SETTINGS = Object.freeze({
  sslRequired: 'external',
  registrationAllowed: false,
  accessTokenLifespan: 300, // 5 min
  ssoSessionIdleTimeout: 28800, // 8 h of inactivity
  ssoSessionMaxLifespan: 86400, // 24 h absolute
  accessCodeLifespan: 60,
  accessCodeLifespanLogin: 1800,
  actionTokenGeneratedByUserLifespan: 900, // reset links live 15 min
  revokeRefreshToken: true, // refresh tokens rotate...
  refreshTokenMaxReuse: 0, // ...and a replayed one revokes the session
  eventsEnabled: true,
  eventsExpiration: 7776000, // 90 days
  adminEventsEnabled: true,
  adminEventsDetailsEnabled: false,
  bruteForceProtected: true,
  permanentLockout: false,
  failureFactor: 5,
  maxFailureWaitSeconds: 900,
});

function isOwnHost(uri) {
  return typeof uri === 'string' && (uri === `https://${HOST_PLACEHOLDER}` || uri.startsWith(`https://${HOST_PLACEHOLDER}/`));
}

/** @param {any} dev parsed development realm. Returns a new object; the input is not modified. */
export function toProdRealm(dev) {
  if (!dev || typeof dev !== 'object' || dev.realm !== 'davrabox') throw new ProdRealmError('expected the davrabox development realm');
  const realm = structuredClone(dev);
  Object.assign(realm, PROD_SETTINGS);

  realm.users = (realm.users ?? []).filter((u) => typeof u.username === 'string' && u.username.startsWith('service-account-'));
  if (!realm.users.some((u) => u.username === SERVICE_ACCOUNT)) {
    throw new ProdRealmError('the admin API service account is missing from the development realm');
  }

  for (const c of realm.clients ?? []) {
    if (Array.isArray(c.redirectUris)) c.redirectUris = c.redirectUris.filter(isOwnHost);
    if (Array.isArray(c.webOrigins)) c.webOrigins = c.webOrigins.filter(isOwnHost);
    if (c.publicClient && (!c.redirectUris || c.redirectUris.length === 0)) {
      throw new ProdRealmError(`public client ${c.clientId} would have no redirect URI left`);
    }
  }
  return realm;
}

/** Returns a list of problems found in a production realm (empty = acceptable). Used by the CLI and the tests. */
export function auditProdRealm(realm) {
  const bad = [];
  if (realm.sslRequired !== 'external' && realm.sslRequired !== 'all') bad.push(`sslRequired is ${realm.sslRequired}`);
  if (realm.registrationAllowed) bad.push('self-registration is on');
  if (!(realm.accessTokenLifespan > 0 && realm.accessTokenLifespan <= 900)) bad.push('access token lifespan must be 1..900 s');
  if (!realm.revokeRefreshToken || realm.refreshTokenMaxReuse !== 0) bad.push('refresh token rotation with reuse detection is off');
  if (!realm.bruteForceProtected) bad.push('brute force protection is off');
  if (!realm.eventsEnabled) bad.push('login events are not recorded');
  for (const u of realm.users ?? []) if (!u.username.startsWith('service-account-')) bad.push(`user ${u.username} must not exist in production`);
  for (const c of realm.clients ?? []) {
    for (const uri of [...(c.redirectUris ?? []), ...(c.webOrigins ?? [])]) {
      if (!isOwnHost(uri)) bad.push(`client ${c.clientId} allows ${uri}`);
      if (/localhost|127\.0\.0\.1|^\*$/.test(uri)) bad.push(`client ${c.clientId} allows a local or wildcard origin ${uri}`);
    }
  }
  return bad;
}
