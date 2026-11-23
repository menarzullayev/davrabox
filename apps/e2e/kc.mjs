// Keycloak admin helpers for e2e tests (local dev stack only).
import { randomBytes } from 'node:crypto';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // Caddy internal CA, local dev stack only
export const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8443';
export const KC = `${BASE}/auth`;
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('KEYCLOAK_ADMIN_PASSWORD is required (source scripts/devenv.sh)');

export async function adminHeaders() {
  const r = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: 'admin-cli', grant_type: 'password', username: 'admin', password: ADMIN_PASSWORD }),
  });
  const tok = (await r.json()).access_token;
  return { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
}

/** Creates a throw-away user in the demo organization; returns credentials and a cleanup function. */
export async function createUser({ roles = ['member'], requiredActions = [] } = {}) {
  const h = await adminHeaders();
  const username = `e2e.${randomBytes(4).toString('hex')}`;
  const password = `Pw-${randomBytes(9).toString('base64url')}`;
  const res = await fetch(`${KC}/admin/realms/davrabox/users`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      username,
      email: `${username}@davrabox.local`,
      firstName: 'E2E',
      lastName: 'User',
      enabled: true,
      emailVerified: true,
      attributes: { org_slug: ['demo'] },
      requiredActions,
      credentials: [{ type: 'password', value: password, temporary: false }],
    }),
  });
  if (res.status !== 201) throw new Error(`user creation failed: ${res.status}`);
  const id = res.headers.get('location').split('/').pop();
  const reps = [];
  for (const r of roles) reps.push(await (await fetch(`${KC}/admin/realms/davrabox/roles/${r}`, { headers: h })).json());
  await fetch(`${KC}/admin/realms/davrabox/users/${id}/role-mappings/realm`, { method: 'POST', headers: h, body: JSON.stringify(reps) });
  return {
    username,
    password,
    cleanup: async () => void (await fetch(`${KC}/admin/realms/davrabox/users/${id}`, { method: 'DELETE', headers: h })),
  };
}
