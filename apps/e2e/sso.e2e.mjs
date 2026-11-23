// End-to-end: enterprise SSO (LDAP federation, OIDC brokering, SAML brokering) through scripts/keycloak-sso.mjs.
// Everything runs in THROW-AWAY realms (sso-test-*) of the shared dev Keycloak; the davrabox realm is never touched.
//   sso-test-ldap : service provider realm with the LDAP federation (OpenLDAP container davra-ldap)
//   sso-test-idp  : acts as customer IdP (OIDC and SAML)
//   sso-test-sp   : service provider realm that brokers sso-test-idp over OIDC and SAML (one tenant per IdP)
// Tokens are obtained through the real browser code flow (public client + PKCE) and then checked with the REAL
// API code (apps/api/src/auth/jwt.ts: identityFromClaims and createVerifier), not a copy.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { KC, adminHeaders } from './kc.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'keycloak-sso.mjs');
const COMPOSE = join(ROOT, 'deploy', 'compose', 'docker-compose.sso.yml');
const CB = 'http://localhost:9/cb';
const CLIENT = 'davrabox-web'; // the client id the API's createVerifier requires (azp)
const R_LDAP = 'sso-test-ldap';
const R_IDP = 'sso-test-idp';
const R_SP = 'sso-test-sp';
const rand = (n = 9) => randomBytes(n).toString('base64url');
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD;

const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};

// ---------- Keycloak admin helpers ----------
let H = await adminHeaders();
let hAt = Date.now();
const adm = async (path, init = {}) => {
  if (Date.now() - hAt > 30_000) {
    H = await adminHeaders(); // master admin tokens live only 60 s
    hAt = Date.now();
  }
  return fetch(`${KC}/admin/realms${path}`, { headers: H, ...init });
};
const must = async (res, what) => {
  if (!res.ok) throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  return res;
};
const idOf = (res) => res.headers.get('location').split('/').pop();

const USER_PERMS = { view: ['admin', 'user'], edit: ['admin', 'user'] };
async function createRealm(name, { managedOrgSlug }) {
  await adm(`/${name}`, { method: 'DELETE' });
  await must(await adm('', { method: 'POST', body: JSON.stringify({ realm: name, enabled: true, sslRequired: 'none', registrationAllowed: false }) }), `realm ${name}`);
  const attributes = [
    { name: 'username', validations: { length: { min: 3, max: 255 } }, permissions: USER_PERMS },
    { name: 'email', validations: { email: {}, length: { max: 255 } }, required: { roles: ['user'] }, permissions: USER_PERMS },
    { name: 'firstName', validations: { length: { max: 255 } }, permissions: USER_PERMS },
    { name: 'lastName', validations: { length: { max: 255 } }, permissions: USER_PERMS },
  ];
  // Same shape as the davrabox realm: org_slug is a managed attribute only an administrator may edit.
  if (managedOrgSlug) attributes.push({ name: 'org_slug', displayName: 'Organization', validations: { pattern: { pattern: '^[a-z0-9][a-z0-9-]{1,62}$', 'error-message': 'invalid organization slug' } }, permissions: { view: ['admin'], edit: ['admin'] } });
  await must(await adm(`/${name}/users/profile`, { method: 'PUT', body: JSON.stringify({ attributes, unmanagedAttributePolicy: managedOrgSlug ? undefined : 'ENABLED' }) }), `profile ${name}`);
  for (const role of ['member', 'org_admin']) await must(await adm(`/${name}/roles`, { method: 'POST', body: JSON.stringify({ name: role }) }), `role ${role}`);
}

async function createUser(realm, { username, email, password, org, roles = [], attrs = {} }) {
  const attributes = { ...attrs, ...(org ? { org_slug: [org] } : {}) };
  const res = await must(
    await adm(`/${realm}/users`, {
      method: 'POST',
      body: JSON.stringify({ username, email, firstName: username.split('.')[0], lastName: 'Tester', enabled: true, emailVerified: true, attributes, credentials: [{ type: 'password', value: password, temporary: false }] }),
    }),
    `user ${username}`,
  );
  const id = idOf(res);
  if (roles.length) {
    const reps = [];
    for (const r of roles) reps.push(await (await adm(`/${realm}/roles/${r}`)).json());
    await must(await adm(`/${realm}/users/${id}/role-mappings/realm`, { method: 'POST', body: JSON.stringify(reps) }), 'roles');
  }
  return id;
}

const orgSlugMapper = (extra = {}) => ({
  name: 'org_slug', protocol: 'openid-connect', protocolMapper: 'oidc-usermodel-attribute-mapper', consentRequired: false,
  config: { 'user.attribute': 'org_slug', 'claim.name': 'org_slug', 'jsonType.label': 'String', 'id.token.claim': 'true', 'access.token.claim': 'true', 'userinfo.token.claim': 'true', ...extra },
});
const addAppClient = async (realm) =>
  must(
    await adm(`/${realm}/clients`, {
      method: 'POST',
      body: JSON.stringify({ clientId: CLIENT, publicClient: true, standardFlowEnabled: true, redirectUris: [`${CB}*`, 'http://localhost:9/*'], attributes: { 'pkce.code.challenge.method': 'S256' }, protocolMappers: [orgSlugMapper()] }),
    }),
    'app client',
  );

// ---------- sso script runner ----------
const tmp = mkdtempSync(join(tmpdir(), 'sso-e2e-'));
function sso(args, { config, env = {} } = {}) {
  const full = [SCRIPT, ...args];
  if (config) {
    const f = join(tmp, `cfg-${rand(4)}.json`);
    writeFileSync(f, JSON.stringify(config));
    full.push('--config', f);
  }
  try {
    const out = execFileSync(process.execPath, full, { env: { ...process.env, KEYCLOAK_URL: KC, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}
const changed = (out) => out.split('\n').filter((l) => /^(create|update|remove) /.test(l));

// ---------- browser code flow ----------
let browser;
const b64 = (b) => Buffer.from(b).toString('base64url');
async function authorize(realm, { hint, interact, expectRefusal = false }) {
  const verifier = rand(32);
  const challenge = b64(createHash('sha256').update(verifier).digest());
  const params = new URLSearchParams({ client_id: CLIENT, redirect_uri: CB, response_type: 'code', scope: 'openid', state: rand(6), code_challenge: challenge, code_challenge_method: 'S256' });
  if (hint) params.set('kc_idp_hint', hint);
  const ctx = await browser.newContext({ locale: 'en-US' });
  try {
    const page = await ctx.newPage();
    await page.route('http://localhost:9/**', (r) => r.fulfill({ status: 200, body: 'callback' }));
    const cb = page.waitForRequest((r) => r.url().startsWith(CB), { timeout: expectRefusal ? 9000 : 30000 }).then((r) => r.url(), () => null);
    await page.goto(`${KC}/realms/${realm}/protocol/openid-connect/auth?${params}`);
    await interact(page);
    const url = await cb;
    if (!url) return { refused: true, text: (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200), url: page.url() };
    const code = new URL(url).searchParams.get('code');
    if (!code) return { refused: true, text: url };
    const tr = await fetch(`${KC}/realms/${realm}/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT, code, redirect_uri: CB, code_verifier: verifier }),
    });
    const body = await tr.json();
    if (!tr.ok) return { refused: true, text: JSON.stringify(body) };
    return { token: body.access_token, claims: JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64url')) };
  } finally {
    await ctx.close();
  }
}
const formLogin = (username, password) => async (page) => {
  await page.waitForSelector('#username', { timeout: 20000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
};
const roleOf = (c) => (c.realm_access?.roles ?? []).filter((r) => r === 'org_admin' || r === 'member').sort().join('+');

// ---------- real API code ----------
const api = await import(pathToFileURL(join(ROOT, 'apps', 'api', 'src', 'auth', 'jwt.ts')).href);
async function apiChecks(label, realm, claims, token, expect) {
  let id;
  try {
    id = api.identityFromClaims(claims);
  } catch (e) {
    check(`${label}: identityFromClaims accepts the claims`, false, String(e.message));
    return;
  }
  check(`${label}: identityFromClaims -> orgSlug=${expect.org} role=${expect.role}`, id.orgSlug === expect.org && id.role === expect.role && id.email === expect.email, JSON.stringify({ org: id.orgSlug, role: id.role, email: id.email }));
  const verify = api.createVerifier([`${KC}/realms/${realm}`], CLIENT, `${KC}/realms/${realm}/protocol/openid-connect/certs`);
  const v = await verify(token).then((x) => x, (e) => e);
  check(`${label}: createVerifier accepts the signed token (iss, JWKS, azp)`, v?.orgSlug === expect.org && v?.role === expect.role, v instanceof Error ? v.message : '');
}

// ---------- docker (LDAP) ----------
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
let startedLdap = false;
function ensureLdap() {
  let running = false;
  try {
    running = sh('docker', ['inspect', '-f', '{{.State.Running}}', 'davra-ldap']) === 'true';
  } catch {
    /* not created */
  }
  if (!running) {
    try {
      sh('docker', ['rm', '-f', '-v', 'davra-ldap']);
    } catch {
      /* none */
    }
    sh('docker', ['compose', '-p', 'davra', '-f', COMPOSE, 'up', '-d'], { env: { ...process.env, LDAP_ADMIN_PASSWORD: `Ldap-${rand(12)}` } });
    startedLdap = true;
  }
  const pw = sh('docker', ['exec', 'davra-ldap', 'printenv', 'LDAP_ADMIN_PASSWORD']);
  for (let i = 0; i < 40; i++) {
    try {
      sh('docker', ['exec', 'davra-ldap', 'ldapsearch', '-x', '-H', 'ldap://localhost', '-D', 'cn=admin,dc=davra,dc=test', '-w', pw, '-b', 'uid=bob.member,ou=people,dc=davra,dc=test', 'dn']);
      return pw;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
    }
  }
  throw new Error('davra-ldap did not become ready');
}
const setLdapPassword = (adminPw, uid, pw) =>
  sh('docker', ['exec', 'davra-ldap', 'ldappasswd', '-x', '-H', 'ldap://localhost', '-D', 'cn=admin,dc=davra,dc=test', '-w', adminPw, '-s', pw, `uid=${uid},ou=people,dc=davra,dc=test`]);

// =====================================================================================
let exit = 0;
try {
  if (!ADMIN_PASSWORD) throw new Error('KEYCLOAK_ADMIN_PASSWORD is required');
  browser = await chromium.launch({ channel: 'msedge' });

  // ---------- (a) LDAP federation ----------
  if (process.env.SSO_E2E_ONLY !== 'broker') {
    // SSO_E2E_ONLY=broker skips this LDAP part when iterating on the brokering tests.
  console.log('--- (a) LDAP federation (OpenLDAP davra-ldap) ---');
  const ldapAdminPw = ensureLdap();
  const pws = { 'alice.admin': `Pw-${rand()}`, 'bob.member': `Pw-${rand()}`, 'carol.locked': `Pw-${rand()}` };
  for (const [u, p] of Object.entries(pws)) setLdapPassword(ldapAdminPw, u, p);
  // Reset the admin group to the seed state (alice only): a previous run may have left bob in it.
  sh('docker', ['exec', '-i', 'davra-ldap', 'ldapmodify', '-x', '-H', 'ldap://localhost', '-D', 'cn=admin,dc=davra,dc=test', '-w', ldapAdminPw], {
    input: 'dn: cn=davra-admins,ou=groups,dc=davra,dc=test\nchangetype: modify\nreplace: member\nmember: uid=alice.admin,ou=people,dc=davra,dc=test\n',
  });
  await createRealm(R_LDAP, { managedOrgSlug: true });
  await addAppClient(R_LDAP);
  const ldapCfg = {
    tenant: 'acme-ldap',
    connectionUrl: 'ldap://davra-ldap:389',
    allowInsecureLdap: true,
    bindDn: 'cn=admin,dc=davra,dc=test',
    usersDn: 'ou=people,dc=davra,dc=test',
    userFilter: '(!(employeeType=suspended))',
    groupsDn: 'ou=groups,dc=davra,dc=test',
    adminGroups: ['davra-admins'],
    fullSyncPeriod: 86400,
    cacheMaxLifespanSeconds: 2,
  };
  const env = { SSO_LDAP_BIND_CREDENTIAL: ldapAdminPw };
  const first = sso(['ldap', '--realm', R_LDAP], { config: ldapCfg, env });
  check('ldap: script applies the federation (exit 0)', first.code === 0, first.code ? first.out.slice(0, 400) : '');
  const second = sso(['ldap', '--realm', R_LDAP], { config: ldapCfg, env });
  check('ldap: second run is idempotent (no create/update/remove)', second.code === 0 && changed(second.out).length === 0, changed(second.out).join(' | '));
  const dry = sso(['ldap', '--realm', R_LDAP, '--dry-run', '--set', 'usersDn="ou=other,dc=davra,dc=test"'], { config: ldapCfg, env });
  check('ldap: --dry-run reports the change but applies nothing', dry.code === 0 && /would +PUT/.test(dry.out), dry.out.slice(0, 200));
  check('ldap: no secret in the output', !first.out.includes(ldapAdminPw) && !second.out.includes(ldapAdminPw));
  const missing = sso(['ldap', '--realm', R_LDAP], { config: ldapCfg, env: { SSO_LDAP_BIND_CREDENTIAL: '' } });
  check('ldap: missing bind credential env is refused', missing.code === 2 && /SSO_LDAP_BIND_CREDENTIAL/.test(missing.out));
  const plain = sso(['ldap', '--realm', R_LDAP], { config: { ...ldapCfg, bindCredential: 'x' }, env });
  check('ldap: a secret inside the config file is refused', plain.code === 2 && /secrets must not be put/.test(plain.out));
  const rebind = sso(['ldap', '--realm', R_LDAP, '--set', 'tenant="other-org"', '--set', 'name="ldap-acme-ldap"'], { config: ldapCfg, env });
  check('ldap: re-pointing the federation to another tenant is refused', rebind.code === 2 && /exactly one organization/.test(rebind.out), rebind.out.slice(0, 200));
  const list = sso(['list', '--realm', R_LDAP]);
  check('ldap: list shows the federation with its tenant', list.code === 0 && /ldap-acme-ldap .*tenant=acme-ldap/.test(list.out), list.out.slice(0, 300));

  const a = await authorize(R_LDAP, { interact: formLogin('alice.admin', pws['alice.admin']) });
  check('ldap: directory admin logs in through the browser form', !!a.claims, a.text);
  if (a.claims) {
    check('ldap: admin token has org_slug=acme-ldap, roles org_admin+member, email', a.claims.org_slug === 'acme-ldap' && roleOf(a.claims) === 'member+org_admin' && a.claims.email === 'alice.admin@acme.test', JSON.stringify({ o: a.claims.org_slug, r: roleOf(a.claims), e: a.claims.email }));
    await apiChecks('ldap admin', R_LDAP, a.claims, a.token, { org: 'acme-ldap', role: 'org_admin', email: 'alice.admin@acme.test' });
  }
  const bob = await authorize(R_LDAP, { interact: formLogin('bob.member', pws['bob.member']) });
  check('ldap: directory member logs in', !!bob.claims, bob.text);
  if (bob.claims) {
    check('ldap: member token has org_slug=acme-ldap and role member only', bob.claims.org_slug === 'acme-ldap' && roleOf(bob.claims) === 'member', JSON.stringify({ o: bob.claims.org_slug, r: roleOf(bob.claims) }));
    await apiChecks('ldap member', R_LDAP, bob.claims, bob.token, { org: 'acme-ldap', role: 'member', email: 'bob.member@acme.test' });
  }
  const wrong = await authorize(R_LDAP, { interact: formLogin('bob.member', 'wrong-password'), expectRefusal: true });
  check('ldap: wrong password is refused', wrong.refused && /Invalid username or password/i.test(wrong.text), wrong.text);
  const locked = await authorize(R_LDAP, { interact: formLogin('carol.locked', pws['carol.locked']), expectRefusal: true });
  check('ldap: suspended/locked directory user is refused (correct password)', locked.refused && /Invalid username or password/i.test(locked.text), locked.text);

  // Deprovisioning: removing alice from the admin group in the directory takes org_admin away at the next login.
  const ldif = `dn: cn=davra-admins,ou=groups,dc=davra,dc=test\nchangetype: modify\ndelete: member\nmember: uid=alice.admin,ou=people,dc=davra,dc=test\n-\nadd: member\nmember: uid=bob.member,ou=people,dc=davra,dc=test\n`;
  sh('docker', ['exec', '-i', 'davra-ldap', 'ldapmodify', '-x', '-H', 'ldap://localhost', '-D', 'cn=admin,dc=davra,dc=test', '-w', ldapAdminPw], { input: ldif });
  await new Promise((r) => setTimeout(r, 3500)); // user cache max lifespan is 2 s in this test
  const demoted = await authorize(R_LDAP, { interact: formLogin('alice.admin', pws['alice.admin']) });
  const promoted = await authorize(R_LDAP, { interact: formLogin('bob.member', pws['bob.member']) });
  check('ldap: leaving the LDAP admin group removes org_admin at the next login; joining grants it', demoted.claims && roleOf(demoted.claims) === 'member' && promoted.claims && roleOf(promoted.claims) === 'member+org_admin', JSON.stringify({ a: demoted.claims && roleOf(demoted.claims), b: promoted.claims && roleOf(promoted.claims) }));

  const rm = sso(['remove', 'ldap-acme-ldap', '--realm', R_LDAP, '--yes']);
  check('ldap: remove deletes the federation and its tenant group', rm.code === 0 && /remove +LDAP federation/.test(rm.out) && /remove +group \/sso-acme-ldap/.test(rm.out), rm.out.slice(0, 300));
  const gone = await authorize(R_LDAP, { interact: formLogin('bob.member', pws['bob.member']), expectRefusal: true });
  check('ldap: after remove, directory users can no longer sign in', gone.refused === true, gone.text);
  await adm(`/${R_LDAP}`, { method: 'DELETE' });
  }

  // ---------- (b)/(c) OIDC and SAML brokering ----------
  console.log('--- (b) OIDC and (c) SAML brokering (sso-test-idp -> sso-test-sp) ---');
  await createRealm(R_IDP, { managedOrgSlug: false });
  await createRealm(R_SP, { managedOrgSlug: true });
  await addAppClient(R_SP);
  const OIDC_ALIAS = 'oidc-acme-oidc';
  const SAML_ALIAS = 'saml-acme-saml';
  const oidcSecret = `Cs-${rand(18)}`;
  const spBase = `${KC}/realms/${R_SP}`;
  // customer IdP: OIDC client + SAML client; every token/assertion CLAIMS org_slug=other-org (must be ignored).
  await must(
    await adm(`/${R_IDP}/clients`, {
      method: 'POST',
      body: JSON.stringify({
        clientId: 'davra-sp-oidc', secret: oidcSecret, publicClient: false, standardFlowEnabled: true, redirectUris: [`${spBase}/broker/${OIDC_ALIAS}/endpoint`],
        protocolMappers: [orgSlugMapper(), { ...orgSlugMapper({ 'user.attribute': 'dept', 'claim.name': 'dept' }), name: 'dept' }],
      }),
    }),
    'idp oidc client',
  );
  const samlMapper = (name, protocolMapper, config) => ({ name, protocol: 'saml', protocolMapper, consentRequired: false, config: { 'attribute.nameformat': 'Basic', ...config } });
  await must(
    await adm(`/${R_IDP}/clients`, {
      method: 'POST',
      body: JSON.stringify({
        clientId: spBase, protocol: 'saml', enabled: true, redirectUris: [`${spBase}/broker/${SAML_ALIAS}/endpoint`],
        attributes: { 'saml.assertion.signature': 'true', 'saml.server.signature': 'true', 'saml.client.signature': 'false', saml_name_id_format: 'email', 'saml.force.post.binding': 'true', saml_assertion_consumer_url_post: `${spBase}/broker/${SAML_ALIAS}/endpoint` },
        protocolMappers: [
          samlMapper('email', 'saml-user-property-mapper', { 'user.attribute': 'email', 'attribute.name': 'email' }),
          samlMapper('firstName', 'saml-user-property-mapper', { 'user.attribute': 'firstName', 'attribute.name': 'firstName' }),
          samlMapper('lastName', 'saml-user-property-mapper', { 'user.attribute': 'lastName', 'attribute.name': 'lastName' }),
          samlMapper('dept', 'saml-user-attribute-mapper', { 'user.attribute': 'dept', 'attribute.name': 'dept' }),
          samlMapper('org_slug', 'saml-user-attribute-mapper', { 'user.attribute': 'org_slug', 'attribute.name': 'org_slug' }),
        ],
      }),
    }),
    'idp saml client',
  );
  const upw = () => `Pw-${rand()}`;
  const idpUsers = {};
  const mkIdp = async (key, dept, email) => {
    const u = { username: key, email: email ?? `${key}@acme.test`, password: upw() };
    idpUsers[key] = { ...u, id: await createUser(R_IDP, { ...u, attrs: { dept: [dept], org_slug: ['other-org'] } }) };
  };
  await mkIdp('oidc.admin', 'it-admins');
  await mkIdp('oidc.user', 'staff');
  await mkIdp('oidc.victim', 'staff', 'victim@acme.test');
  await mkIdp('oidc.colleague', 'staff', 'colleague@acme.test');
  await mkIdp('oidc.late', 'staff', 'late@acme.test');
  await mkIdp('saml.admin', 'it-admins');
  await mkIdp('saml.user', 'staff');
  await mkIdp('saml.victim', 'staff', 'victim2@acme.test');
  // Local accounts of the service provider realm that an IdP might try to take over by asserting their email.
  const victimId = await createUser(R_SP, { username: 'victim', email: 'victim@acme.test', password: upw(), org: 'other-org', roles: ['member'] });
  await createUser(R_SP, { username: 'victim2', email: 'victim2@acme.test', password: upw(), org: 'other-org', roles: ['member'] });
  await createUser(R_SP, { username: 'colleague', email: 'colleague@acme.test', password: upw(), org: 'acme-oidc', roles: ['member'] });
  const lateId = await createUser(R_SP, { username: 'late', email: 'late@acme.test', password: upw(), org: 'acme-oidc', roles: ['member'] });

  const oidcCfg = {
    tenant: 'acme-oidc',
    discoveryUrl: `${KC}/realms/${R_IDP}/.well-known/openid-configuration`,
    allowInsecureHttp: true,
    clientId: 'davra-sp-oidc',
    displayName: 'Acme SSO',
    trustEmail: false,
    adminRule: { claim: 'dept', value: 'it-admins' },
  };
  const oenv = { SSO_OIDC_CLIENT_SECRET: oidcSecret };
  const o1 = sso(['oidc', '--realm', R_SP], { config: oidcCfg, env: oenv });
  check('oidc: script applies the identity provider (exit 0)', o1.code === 0, o1.code ? o1.out.slice(0, 500) : '');
  check('oidc: output tells the redirect URI and kc_idp_hint', /broker\/oidc-acme-oidc\/endpoint/.test(o1.out) && /kc_idp_hint=oidc-acme-oidc/.test(o1.out));
  const o2 = sso(['oidc', '--realm', R_SP], { config: oidcCfg, env: oenv });
  check('oidc: second run is idempotent (no create/update/remove)', o2.code === 0 && changed(o2.out).length === 0, changed(o2.out).join(' | '));
  check('oidc: no client secret in the output', !o1.out.includes(oidcSecret) && !o2.out.includes(oidcSecret));
  const oRebind = sso(['oidc', '--realm', R_SP, '--set', 'tenant="other-org"', '--set', 'alias="oidc-acme-oidc"'], { config: oidcCfg, env: oenv });
  check('oidc: re-pointing the IdP to another tenant is refused', oRebind.code === 2 && /exactly one organization/.test(oRebind.out), oRebind.out.slice(0, 200));

  // First: emails NOT trusted -> an IdP user whose email matches an existing local account is refused.
  const late1 = await authorize(R_SP, { hint: OIDC_ALIAS, interact: formLogin('oidc.late', idpUsers['oidc.late'].password), expectRefusal: true });
  check('oidc: untrusted email matching an existing account is refused (no silent link)', late1.refused === true, late1.text);

  const oa = await authorize(R_SP, { hint: OIDC_ALIAS, interact: formLogin('oidc.admin', idpUsers['oidc.admin'].password) });
  check('oidc: kc_idp_hint skips the realm login page and brokers to the IdP; new user created without a profile page', !!oa.claims, oa.text + ' ' + (oa.url ?? ''));
  if (oa.claims) {
    check('oidc: IdP sent org_slug=other-org but the token has the hardcoded acme-oidc', oa.claims.org_slug === 'acme-oidc', String(oa.claims.org_slug));
    check('oidc: admin claim dept=it-admins maps to org_admin (+ member)', roleOf(oa.claims) === 'member+org_admin', roleOf(oa.claims));
    await apiChecks('oidc admin', R_SP, oa.claims, oa.token, { org: 'acme-oidc', role: 'org_admin', email: 'oidc.admin@acme.test' });
  }
  // Same user through the IdP button on the realm login page (no hint), after being demoted at the IdP.
  await must(await adm(`/${R_IDP}/users/${idpUsers['oidc.admin'].id}`, { method: 'PUT', body: JSON.stringify({ username: 'oidc.admin', email: 'oidc.admin@acme.test', firstName: 'oidc', lastName: 'Tester', emailVerified: true, enabled: true, attributes: { dept: ['staff'], org_slug: ['other-org'] } }) }), 'demote');
  const ob = await authorize(R_SP, {
    interact: async (page) => {
      await page.waitForSelector('#social-' + OIDC_ALIAS, { timeout: 20000 });
      await page.click('#social-' + OIDC_ALIAS);
      await formLogin('oidc.admin', idpUsers['oidc.admin'].password)(page);
    },
  });
  check('oidc: login through the IdP button on the realm login page works', !!ob.claims, ob.text);
  if (ob.claims) check('oidc: losing the admin claim at the IdP removes org_admin at the next login', roleOf(ob.claims) === 'member' && ob.claims.org_slug === 'acme-oidc', JSON.stringify({ r: roleOf(ob.claims), o: ob.claims.org_slug }));
  const ou = await authorize(R_SP, { hint: OIDC_ALIAS, interact: formLogin('oidc.user', idpUsers['oidc.user'].password) });
  check('oidc: ordinary user gets role member only, org acme-oidc', ou.claims && roleOf(ou.claims) === 'member' && ou.claims.org_slug === 'acme-oidc', ou.text ?? JSON.stringify(ou.claims && roleOf(ou.claims)));
  if (ou.claims) await apiChecks('oidc member', R_SP, ou.claims, ou.token, { org: 'acme-oidc', role: 'member', email: 'oidc.user@acme.test' });

  // Cross-tenant takeover attempt with trusted emails: victim@ belongs to other-org.
  const o3 = sso(['oidc', '--realm', R_SP, '--set', 'trustEmail=true'], { config: oidcCfg, env: oenv });
  check('oidc: switching to trustEmail=true updates the IdP and recreates the login flow', o3.code === 0 && /update +login flow/.test(o3.out) && /update +identity provider/.test(o3.out), o3.out.slice(0, 500));
  const vic = await authorize(R_SP, { hint: OIDC_ALIAS, interact: formLogin('oidc.victim', idpUsers['oidc.victim'].password), expectRefusal: true });
  const victimNow = await (await adm(`/${R_SP}/users/${victimId}`)).json();
  check('oidc: IdP of tenant acme-oidc cannot take over a local account of tenant other-org by asserting its email', vic.refused === true && /another organization|denied|error/i.test(vic.text), vic.text);
  check('oidc: the victim account is untouched (still org other-org, no federated link)', victimNow.attributes?.org_slug?.[0] === 'other-org' && (await (await adm(`/${R_SP}/users/${victimId}/federated-identity`)).json()).length === 0);
  const colleague = await authorize(R_SP, { hint: OIDC_ALIAS, interact: formLogin('oidc.colleague', idpUsers['oidc.colleague'].password) });
  check('oidc: trusted email auto-links an existing account of the SAME tenant (no review page)', !!colleague.claims && colleague.claims.org_slug === 'acme-oidc', colleague.text);
  const late2 = await authorize(R_SP, { hint: OIDC_ALIAS, interact: formLogin('oidc.late', idpUsers['oidc.late'].password) });
  check('oidc: ... and the existing account is the one used (same subject)', !!late2.claims && late2.claims.sub === lateId, late2.text);
  const o4 = sso(['oidc', '--realm', R_SP, '--set', 'trustEmail=true'], { config: oidcCfg, env: oenv });
  check('oidc: rerun after the change is idempotent again', o4.code === 0 && changed(o4.out).length === 0, changed(o4.out).join(' | '));

  // ---- SAML ----
  const samlCfg = { tenant: 'acme-saml', metadataUrl: `${KC}/realms/${R_IDP}/protocol/saml/descriptor`, allowInsecureHttp: true, displayName: 'Acme SAML', trustEmail: true, adminRule: { attribute: 'dept', value: 'it-admins' } };
  const s1 = sso(['saml', '--realm', R_SP], { config: samlCfg, env: { KEYCLOAK_PUBLIC_URL: KC } });
  check('saml: script applies the identity provider (exit 0)', s1.code === 0, s1.code ? s1.out.slice(0, 500) : '');
  check('saml: output prints entity ID, ACS URL, metadata URL for the customer', s1.out.includes(`SP entity ID (Audience)   : ${spBase}`) && s1.out.includes(`${spBase}/broker/${SAML_ALIAS}/endpoint`) && s1.out.includes('endpoint/descriptor'), s1.out.slice(-500));
  const s2 = sso(['saml', '--realm', R_SP], { config: samlCfg });
  check('saml: second run is idempotent (no create/update/remove)', s2.code === 0 && changed(s2.out).length === 0, changed(s2.out).join(' | '));
  const idpRep = await (await adm(`/${R_SP}/identity-provider/instances/${SAML_ALIAS}`)).json();
  check('saml: stored IdP validates signatures and requires signed assertions', idpRep.config.validateSignature === 'true' && idpRep.config.wantAssertionsSigned === 'true' && !!idpRep.config.signingCertificate, JSON.stringify({ v: idpRep.config.validateSignature, w: idpRep.config.wantAssertionsSigned }));
  const meta = await fetch(`${spBase}/broker/${SAML_ALIAS}/endpoint/descriptor`);
  const metaText = await meta.text();
  check('saml: the SP metadata URL printed for the customer serves a descriptor with the ACS URL', meta.ok && metaText.includes('AssertionConsumerService') && metaText.includes(`/broker/${SAML_ALIAS}/endpoint`), `${meta.status}`);
  const sa = await authorize(R_SP, { hint: SAML_ALIAS, interact: formLogin('saml.admin', idpUsers['saml.admin'].password) });
  check('saml: login through the SAML IdP (kc_idp_hint) works', !!sa.claims, sa.text + ' ' + (sa.url ?? ''));
  if (sa.claims) {
    check('saml: IdP asserted org_slug=other-org but the token has the hardcoded acme-saml', sa.claims.org_slug === 'acme-saml', String(sa.claims.org_slug));
    check('saml: attribute dept=it-admins maps to org_admin (+ member)', roleOf(sa.claims) === 'member+org_admin', roleOf(sa.claims));
    await apiChecks('saml admin', R_SP, sa.claims, sa.token, { org: 'acme-saml', role: 'org_admin', email: 'saml.admin@acme.test' });
  }
  const su = await authorize(R_SP, { hint: SAML_ALIAS, interact: formLogin('saml.user', idpUsers['saml.user'].password) });
  check('saml: ordinary user gets role member only, org acme-saml, email from the assertion', su.claims && roleOf(su.claims) === 'member' && su.claims.org_slug === 'acme-saml' && su.claims.email === 'saml.user@acme.test', su.text ?? '');
  if (su.claims) await apiChecks('saml member', R_SP, su.claims, su.token, { org: 'acme-saml', role: 'member', email: 'saml.user@acme.test' });
  const sv = await authorize(R_SP, { hint: SAML_ALIAS, interact: formLogin('saml.victim', idpUsers['saml.victim'].password), expectRefusal: true });
  check('saml: SAML IdP of tenant acme-saml cannot take over a local account of another tenant by email', sv.refused === true, sv.text);

  // ---- IdP list and remove ----
  const l2 = sso(['list', '--realm', R_SP]);
  check('list: shows both IdPs with their tenants and no UNSAFE/UNMAPPED marker', l2.code === 0 && /oidc-acme-oidc .*tenant=acme-oidc/.test(l2.out) && /saml-acme-saml .*tenant=acme-saml/.test(l2.out) && !/UNSAFE|UNMAPPED/.test(l2.out), l2.out.slice(0, 400));
  const r1 = sso(['remove', SAML_ALIAS, '--realm', R_SP]);
  check('remove: refuses without --yes', r1.code === 2);
  const r2 = sso(['remove', SAML_ALIAS, '--realm', R_SP, '--yes']);
  const flows = await (await adm(`/${R_SP}/authentication/flows`)).json();
  check('remove: deletes the IdP and its login flow', r2.code === 0 && !flows.some((f) => f.alias === `sso-broker-${SAML_ALIAS}`) && (await adm(`/${R_SP}/identity-provider/instances/${SAML_ALIAS}`)).status === 404, r2.out.slice(0, 300));

  // ---- the guard against an unsafe mapper added by hand ----
  await must(await adm(`/${R_SP}/identity-provider/instances/${OIDC_ALIAS}/mappers`, { method: 'POST', body: JSON.stringify({ name: 'evil', identityProviderAlias: OIDC_ALIAS, identityProviderMapper: 'oidc-user-attribute-idp-mapper', config: { claim: 'org_slug', 'user.attribute': 'org_slug', syncMode: 'FORCE' } }) }), 'evil mapper');
  const lu = sso(['list', '--realm', R_SP]);
  const u1 = sso(['oidc', '--realm', R_SP], { config: oidcCfg, env: oenv });
  check('safety: a hand-made mapper copying org_slug from the IdP is flagged by list and blocks apply', /UNSAFE: evil/.test(lu.out) && u1.code === 1 && /org_slug must stay hardcoded/.test(u1.out), u1.out.slice(0, 300));
} catch (e) {
  console.log('FAILED  unexpected error :: ' + (e.stack ?? String(e)).split('\n').slice(0, 4).join(' | '));
  exit = 1;
} finally {
  await browser?.close().catch(() => undefined);
  H = await adminHeaders();
  for (const r of [R_LDAP, R_IDP, R_SP]) await adm(`/${r}`, { method: 'DELETE' }).catch(() => undefined);
  if (startedLdap && !process.env.E2E_KEEP_LDAP) {
    try {
      sh('docker', ['rm', '-f', '-v', 'davra-ldap']);
    } catch {
      /* ignore */
    }
  }
  rmSync(tmp, { recursive: true, force: true });
}
if (results.some((r) => !r)) exit = 1;
console.log(exit === 0 ? 'SSO E2E: ALL PASSED' : 'SSO E2E: FAILURES');
process.exit(exit);
