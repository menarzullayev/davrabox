// Idempotent: makes TOTP mandatory for users holding the realm role org_admin, while members who
// have enrolled an authenticator of their own are still challenged for it.
//
// Flow "browser-admin-2fa" is a copy of the built-in browser flow whose forms step has two conditional
// sub-flows, evaluated independently:
//   A "Admin OTP":    [ Condition user-role = org_admin ,               OTP Form ]            -> admins, always
//   B "Conditional OTP" (built in): [ user configured , NOT org_admin , ( OTP Form | passkey ) ] -> members who enrolled
// An admin therefore meets exactly one OTP step (A); the OTP form enrols a new authenticator when none exists.
//
// Usage: KEYCLOAK_URL=http://127.0.0.1:8180/auth KEYCLOAK_ADMIN_PASSWORD=... node scripts/keycloak-admin-2fa.mjs
const BASE = process.env.KEYCLOAK_URL ?? 'http://127.0.0.1:8180/auth';
const REALM = process.env.KEYCLOAK_REALM ?? 'davrabox';
const PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD;
if (!PASSWORD) throw new Error('KEYCLOAK_ADMIN_PASSWORD is required');
const FLOW = 'browser-admin-2fa';
const ADMIN_SUB = `${FLOW} Admin OTP`;

const tr = await fetch(`${BASE}/realms/master/protocol/openid-connect/token`, {
  method: 'POST',
  body: new URLSearchParams({ client_id: 'admin-cli', grant_type: 'password', username: 'admin', password: PASSWORD }),
});
if (!tr.ok) throw new Error(`admin token failed: ${tr.status}`);
const h = { Authorization: `Bearer ${(await tr.json()).access_token}`, 'Content-Type': 'application/json' };
const api = (path, init = {}) => fetch(`${BASE}/admin/realms/${REALM}${path}`, { headers: h, ...init });
const must = async (res, what) => {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  return res;
};
const enc = encodeURIComponent;

// `--off` switches every second-factor prompt off (user decision 2026-11-24): the realm goes back to the built-in
// browser flow and its conditional OTP step is disabled, so nobody is asked to enrol or enter an authenticator code.
// The custom flow stays in the realm, so running this script without `--off` turns the enforcement back on.
if (process.argv.includes('--off')) {
  const realm0 = await (await must(await fetch(`${BASE}/admin/realms/${REALM}`, { headers: h }), 'get realm')).json();
  if (realm0.browserFlow !== 'browser') {
    await must(await fetch(`${BASE}/admin/realms/${REALM}`, { method: 'PUT', headers: h, body: JSON.stringify({ ...realm0, browserFlow: 'browser' }) }), 'bind built-in browser flow');
  }
  const ex = await (await must(await api('/authentication/flows/browser/executions'), 'list built-in executions')).json();
  for (const e of ex.filter((x) => x.authenticationFlow && /conditional/i.test(x.displayName ?? '') && /(otp|2fa)/i.test(x.displayName ?? '') && x.requirement !== 'DISABLED')) {
    await must(await api('/authentication/flows/browser/executions', { method: 'PUT', body: JSON.stringify({ ...e, requirement: 'DISABLED' }) }), `disable ${e.displayName}`);
  }
  console.log('2FA is OFF: built-in browser flow, conditional OTP disabled');
  process.exit(0);
}
const list = async () => (await must(await api(`/authentication/flows/${enc(FLOW)}/executions`), 'list executions')).json();
const put = async (e, requirement) =>
  must(await api(`/authentication/flows/${enc(FLOW)}/executions`, { method: 'PUT', body: JSON.stringify({ ...e, requirement }) }), `set ${e.displayName}`);
const childrenOf = (ex, flow) => {
  const i = ex.findIndex((e) => e.id === flow.id);
  const out = [];
  for (let k = i + 1; k < ex.length && ex[k].level > flow.level; k++) out.push(ex[k]);
  return out;
};
// Creates the execution config, or updates it when it exists with different values (idempotent).
const configure = async (e, alias, config) => {
  if (!e.authenticationConfig) {
    return must(await api(`/authentication/executions/${e.id}/config`, { method: 'POST', body: JSON.stringify({ alias, config }) }), `configure ${alias}`);
  }
  const cur = await (await must(await api(`/authentication/config/${e.authenticationConfig}`), `read ${alias}`)).json();
  if (JSON.stringify(cur.config) === JSON.stringify(config)) return undefined;
  return must(await api(`/authentication/config/${e.authenticationConfig}`, { method: 'PUT', body: JSON.stringify({ ...cur, alias, config }) }), `update ${alias}`);
};

const flows = await (await must(await api('/authentication/flows'), 'list flows')).json();
if (!flows.some((f) => f.alias === FLOW)) {
  await must(await api('/authentication/flows/browser/copy', { method: 'POST', body: JSON.stringify({ newName: FLOW }) }), 'copy flow');
}
let ex = await list();

const forms = ex.find((e) => e.authenticationFlow && e.displayName === `${FLOW} forms`);
const memberSub = ex.find((e) => e.authenticationFlow && /Conditional OTP/i.test(e.displayName));
if (!forms || !memberSub) throw new Error('expected sub-flows not found in the copied flow');

// Sub-flow A: admins.
if (!ex.some((e) => e.displayName === ADMIN_SUB)) {
  await must(
    await api(`/authentication/flows/${enc(forms.displayName)}/executions/flow`, {
      method: 'POST',
      body: JSON.stringify({ alias: ADMIN_SUB, type: 'basic-flow', description: 'OTP is mandatory for org_admin', provider: 'registration-page-form' }),
    }),
    'create admin sub-flow',
  );
  ex = await list();
}
const adminSub = ex.find((e) => e.displayName === ADMIN_SUB);
if (adminSub.requirement !== 'CONDITIONAL') await put(adminSub, 'CONDITIONAL');

const addIf = async (flowAlias, provider) => {
  await must(await api(`/authentication/flows/${enc(flowAlias)}/executions/execution`, { method: 'POST', body: JSON.stringify({ provider }) }), `add ${provider}`);
  ex = await list();
};
const flowEx = (alias) => ex.find((e) => e.displayName === alias);
const kids = (alias) => childrenOf(ex, flowEx(alias));
const direct = (alias) => kids(alias).filter((k) => k.level === flowEx(alias).level + 1);
const remove = async (e) => {
  await must(await api(`/authentication/executions/${e.id}`, { method: 'DELETE' }), `remove ${e.displayName}`);
  ex = await list();
};

// A: admins always meet the OTP form, which enrols an authenticator-app when none exists.
if (!kids(ADMIN_SUB).some((e) => e.providerId === 'conditional-user-role')) await addIf(ADMIN_SUB, 'conditional-user-role');
// Clean up the nested method sub-flow tried by an earlier version (a REQUIRED/ALTERNATIVE mix fails for users
// without any enrolled factor, and this Keycloak has no condition for "has a passkey").
const oldMethod = ex.find((e) => e.displayName === `${FLOW} 2FA method`);
if (oldMethod) await remove(oldMethod);
if (!kids(ADMIN_SUB).some((e) => e.providerId === 'auth-otp-form')) await addIf(ADMIN_SUB, 'auth-otp-form');
for (const e of direct(ADMIN_SUB)) if (e.requirement !== 'REQUIRED') await put(e, 'REQUIRED');
await configure(kids(ADMIN_SUB).find((e) => e.providerId === 'conditional-user-role'), 'is-org-admin', { condUserRole: 'org_admin', negate: 'false' });

// B: members who enrolled any second factor (authenticator app OR passkey) are challenged with whichever they have.
// Same shape as Keycloak's own conditional 2FA flow: conditions (REQUIRED) plus the two factors as ALTERNATIVEs
// directly in the flow. A nested sub-flow would break the "user configured" check, which only looks at the
// authenticators that are direct children of the conditional flow.
const bAlias = memberSub.displayName;
const MEMBER_METHOD = `${FLOW} member 2FA method`;
ex = await list();
const nested = ex.find((e) => e.displayName === MEMBER_METHOD);
if (nested) await remove(nested);
if (!direct(bAlias).some((e) => e.providerId === 'auth-otp-form')) await addIf(bAlias, 'auth-otp-form');
if (!direct(bAlias).some((e) => e.providerId === 'webauthn-authenticator')) await addIf(bAlias, 'webauthn-authenticator');
for (const e of direct(bAlias).filter((k) => k.providerId === 'auth-otp-form' || k.providerId === 'webauthn-authenticator')) {
  if (e.requirement !== 'ALTERNATIVE') await put(e, 'ALTERNATIVE');
}
for (const e of direct(bAlias).filter((k) => k.providerId === 'conditional-user-configured')) if (e.requirement !== 'REQUIRED') await put(e, 'REQUIRED');
let bRole = direct(bAlias).find((e) => e.providerId === 'conditional-user-role');
if (!bRole) {
  await addIf(bAlias, 'conditional-user-role');
  bRole = direct(bAlias).find((e) => e.providerId === 'conditional-user-role');
}
if (bRole.requirement !== 'REQUIRED') await put(bRole, 'REQUIRED');
await configure(bRole, 'is-not-org-admin', { condUserRole: 'org_admin', negate: 'true' });

const realm = await (await must(await fetch(`${BASE}/admin/realms/${REALM}`, { headers: h }), 'get realm')).json();
if (realm.browserFlow !== FLOW) {
  await must(await fetch(`${BASE}/admin/realms/${REALM}`, { method: 'PUT', headers: h, body: JSON.stringify({ ...realm, browserFlow: FLOW }) }), 'bind browser flow');
}
console.log(`org_admin 2FA enforced via flow "${FLOW}"`);
