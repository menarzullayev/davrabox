#!/usr/bin/env node
// Enterprise SSO for DavraBox: configures LDAP/AD federation, OIDC and SAML identity providers in a Keycloak
// realm through the admin REST API. Idempotent: rerunning with the same config changes nothing.
//
//   node scripts/keycloak-sso.mjs ldap   --config ldap.json   [--realm davrabox] [--dry-run] [--sync]
//   node scripts/keycloak-sso.mjs oidc   --config oidc.json   [--realm davrabox] [--dry-run]
//   node scripts/keycloak-sso.mjs saml   --config saml.json   [--realm davrabox] [--dry-run]
//   node scripts/keycloak-sso.mjs list   [--realm davrabox]
//   node scripts/keycloak-sso.mjs remove <alias-or-federation-name> --yes [--realm davrabox]
//
// Config comes from a JSON file (--config) and/or repeated --set key=value (dotted keys, JSON values).
// Secrets are NEVER read from the file: bind credential / client secret come from the environment variable named by
// bindCredentialEnv / clientSecretEnv.
// Connection: KEYCLOAK_URL (default http://127.0.0.1:8180/auth), KEYCLOAK_ADMIN_USER (default admin),
// KEYCLOAK_ADMIN_PASSWORD (required), KEYCLOAK_PUBLIC_URL (what the customer's IdP admin sees; default KEYCLOAK_URL).
// See docs/sso.md.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import * as S from './lib/sso.mjs';

const USAGE = 'usage: keycloak-sso.mjs <ldap|oidc|saml|list|remove> [alias] [--config file.json] [--set k=v]... [--realm r] [--dry-run] [--sync] [--force-secrets] [--yes]';

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      set: { type: 'string', multiple: true },
      realm: { type: 'string', default: 'davrabox' },
      'dry-run': { type: 'boolean', default: false },
      sync: { type: 'boolean', default: false },
      'force-secrets': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
    },
  });
  return { cmd: positionals[0], arg: positionals[1], flags: values };
}

/** Merges the JSON file and --set overrides (dotted keys; values parsed as JSON when possible). */
export function loadConfig(flags, readFile = (p) => readFileSync(p, 'utf8')) {
  let cfg = {};
  if (flags.config) {
    try {
      cfg = JSON.parse(readFile(flags.config));
    } catch (e) {
      throw new S.ConfigError(`cannot read config ${flags.config}: ${e.message}`);
    }
  }
  for (const kv of flags.set ?? []) {
    const i = kv.indexOf('=');
    if (i < 1) throw new S.ConfigError(`--set expects key=value, got "${kv}"`);
    const path = kv.slice(0, i).split('.');
    let raw = kv.slice(i + 1);
    try {
      raw = JSON.parse(raw);
    } catch {
      /* keep the string */
    }
    let o = cfg;
    for (const p of path.slice(0, -1)) o = o[p] && typeof o[p] === 'object' ? o[p] : (o[p] = {});
    o[path.at(-1)] = raw;
  }
  return cfg;
}

// ---------- Keycloak admin client ----------

class Admin {
  constructor(base, realm, dry) {
    this.base = base.replace(/\/+$/, '');
    this.realm = realm;
    this.dry = dry;
  }
  async login() {
    const password = process.env.KEYCLOAK_ADMIN_PASSWORD;
    if (!password) throw new S.ConfigError('KEYCLOAK_ADMIN_PASSWORD is required');
    const r = await fetch(`${this.base}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({ client_id: 'admin-cli', grant_type: 'password', username: process.env.KEYCLOAK_ADMIN_USER ?? 'admin', password }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`admin login failed: ${r.status}`);
    this.token = (await r.json()).access_token;
  }
  async raw(method, path, body, headers = {}) {
    const isForm = body instanceof FormData;
    return fetch(`${this.base}/admin/realms/${this.realm}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
  }
  async get(path, { allow404 = false } = {}) {
    const r = await this.raw('GET', path);
    if (allow404 && r.status === 404) return undefined;
    if (!r.ok) throw new Error(`GET ${path} failed: ${r.status} ${await r.text()}`);
    return r.json();
  }
  /** Mutating call; in dry-run mode it only logs. Returns the Location id for creates. */
  async mut(method, path, body, what) {
    if (this.dry) {
      log('would', `${method} ${what}`);
      return { id: undefined, dry: true };
    }
    const r = await this.raw(method, path, body);
    if (!r.ok) throw new Error(`${what} failed: ${r.status} ${await r.text()}`);
    const loc = r.headers.get('location');
    const text = await r.text();
    return { id: loc ? loc.split('/').pop() : undefined, body: text ? safeJson(text) : undefined };
  }
}
const safeJson = (t) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const enc = encodeURIComponent;
const log = (verb, msg) => console.log(`${verb.padEnd(9)} ${msg}`);

// ---------- shared pieces ----------

async function requireRoles(kc) {
  for (const role of [S.ROLE_MEMBER, S.ROLE_ADMIN]) {
    if (!(await kc.get(`/roles/${enc(role)}`, { allow404: true }))) throw new Error(`realm "${kc.realm}" has no realm role "${role}"; import the DavraBox realm first`);
  }
}

async function applyMapperPlan(kc, plan, { createPath, itemPath, label, withParent }) {
  for (const m of plan.remove) {
    await kc.mut('DELETE', itemPath(m.id), undefined, `${label} ${m.name}`);
    log('remove', `${label} ${m.name}`);
  }
  for (const m of plan.create) {
    await kc.mut('POST', createPath, m, `${label} ${m.name}`);
    log('create', `${label} ${m.name}`);
  }
  for (const u of plan.update) {
    await kc.mut('PUT', itemPath(u.existing.id), { ...u.existing, ...u.desired, id: u.existing.id, config: { ...u.existing.config, ...u.desired.config } }, `${label} ${u.desired.name}`);
    log('update', `${label} ${u.desired.name} (${u.changes.join(', ')})`);
  }
  for (const m of plan.same) log('ok', `${label} ${m.name}`);
  void withParent;
}

async function ensureTenantGroup(kc, tenant) {
  const name = S.tenantGroupName(tenant);
  const found = (await kc.get(`/groups?search=${enc(name)}&exact=true`)).find((g) => g.name === name);
  let id = found?.id;
  if (!found) {
    id = (await kc.mut('POST', '/groups', { name, attributes: { org_slug: [tenant] } }, `group ${name}`)).id;
    log('create', `group /${name} (org_slug=${tenant})`);
  } else {
    const have = (await kc.get(`/groups/${id}`)).attributes?.org_slug ?? [];
    if (have.length !== 1 || have[0] !== tenant) {
      await kc.mut('PUT', `/groups/${id}`, { ...(await kc.get(`/groups/${id}`)), attributes: { ...found.attributes, org_slug: [tenant] } }, `group ${name} org_slug`);
      log('update', `group /${name} org_slug -> ${tenant}`);
    } else log('ok', `group /${name}`);
  }
  if (id) await ensureGroupRole(kc, id, S.ROLE_MEMBER, name);
  return id;
}

async function ensureGroupRole(kc, groupId, role, label) {
  const have = await kc.get(`/groups/${groupId}/role-mappings/realm`);
  if (have.some((r) => r.name === role)) return log('ok', `group ${label} has role ${role}`);
  const rep = await kc.get(`/roles/${enc(role)}`);
  await kc.mut('POST', `/groups/${groupId}/role-mappings/realm`, [rep], `role ${role} on group ${label}`);
  log('create', `role ${role} on group ${label}`);
}

// ---------- ldap ----------

async function cmdLdap(kc, cfgRaw, flags) {
  const c = S.validateLdapConfig(cfgRaw);
  const secret = process.env[c.bindCredentialEnv];
  if (!secret && !flags['dry-run']) throw new S.ConfigError(`environment variable ${c.bindCredentialEnv} (bind credential) is not set`);
  await requireRoles(kc);
  const realm = await kc.get('');
  const comps = await kc.get(`/components?type=${enc(S.LDAP_COMPONENT)}&parent=${realm.id}`);
  const existing = comps.find((x) => x.name === c.name);
  if (existing && existing.providerId !== 'ldap') throw new Error(`component "${c.name}" exists but is not an LDAP federation`);
  const existingMappers = existing ? await kc.get(`/components?parent=${existing.id}&type=${enc(S.LDAP_MAPPER_TYPE)}`) : [];
  const bound = existingMappers.find((m) => m.name === `${S.MANAGED_PREFIX}tenant group`)?.config?.group?.[0];
  S.assertTenantUnchanged(bound && bound.replace(/^\/sso-/, ''), c.tenant, `federation "${c.name}"`);

  const groupId = await ensureTenantGroup(kc, c.tenant);
  const desired = S.buildLdapComponent(c, realm.id, secret);
  let fedId = existing?.id;
  if (!existing) {
    fedId = (await kc.mut('POST', '/components', desired, `federation ${c.name}`)).id;
    log('create', `LDAP federation ${c.name} (${c.connectionUrl}, tenant ${c.tenant})`);
  } else {
    const changes = S.diffConfig(existing.config, desired.config, { secretKeys: ['bindCredential'], forceSecrets: flags['force-secrets'] });
    if (changes.length) {
      await kc.mut('PUT', `/components/${existing.id}`, { ...existing, ...desired, id: existing.id, config: { ...existing.config, ...desired.config } }, `federation ${c.name}`);
      log('update', `LDAP federation ${c.name} (${changes.join(', ')})`);
    } else log('ok', `LDAP federation ${c.name}`);
  }
  if (!fedId) return; // dry-run on a federation that does not exist yet

  const mappers = existing ? existingMappers : await kc.get(`/components?parent=${fedId}&type=${enc(S.LDAP_MAPPER_TYPE)}`);
  const plan = S.planNamed(mappers, S.buildLdapMappers(c, fedId), { kindOf: S.ldapMapperKind });
  await applyMapperPlan(kc, plan, { createPath: '/components', itemPath: (id) => `/components/${id}`, label: 'LDAP mapper' });

  // Admin groups: pre-create the Keycloak groups under the tenant group with role org_admin, then let the
  // group mapper link LDAP membership to them.
  if (groupId) {
    const children = await kc.get(`/groups/${groupId}/children?first=0&max=1000`);
    const wanted = new Map(c.adminGroups.map((g) => [g.toLowerCase(), g]));
    for (const g of children) {
      if (!wanted.has(g.name.toLowerCase())) {
        await kc.mut('DELETE', `/groups/${g.id}`, undefined, `stale admin group ${g.name}`);
        log('remove', `stale admin group /${S.tenantGroupName(c.tenant)}/${g.name}`);
      }
    }
    for (const [lower, name] of wanted) {
      let g = children.find((x) => x.name.toLowerCase() === lower);
      if (!g) {
        const r = await kc.mut('POST', `/groups/${groupId}/children`, { name }, `admin group ${name}`);
        g = { id: r.id, name };
        log('create', `admin group /${S.tenantGroupName(c.tenant)}/${name}`);
      }
      if (g.id) await ensureGroupRole(kc, g.id, S.ROLE_ADMIN, name);
    }
  }
  if (c.adminGroups.length) {
    const m = (await kc.get(`/components?parent=${fedId}&type=${enc(S.LDAP_MAPPER_TYPE)}`)).find((x) => x.name === `${S.MANAGED_PREFIX}admin groups`);
    if (m) {
      const r = await kc.mut('POST', `/user-storage/${fedId}/mappers/${m.id}/sync?direction=fedToKeycloak`, undefined, 'admin group sync');
      log('sync', `admin groups ${JSON.stringify(r.body?.status ?? 'done')}`);
    }
  }
  if (flags.sync && c.importUsers) {
    const r = await kc.mut('POST', `/user-storage/${fedId}/sync?action=triggerFullSync`, undefined, 'full user sync');
    log('sync', `users ${JSON.stringify(r.body?.status ?? 'done')}`);
  }
  console.log(`\nDone. LDAP users of "${c.name}" belong to organization "${c.tenant}"; members of ${c.adminGroups.length ? c.adminGroups.join(', ') : '(no admin group configured)'} get org_admin.`);
}

// ---------- oidc / saml ----------

async function importConfig(kc, providerId, { fromUrl, file }) {
  let r;
  if (file) {
    const fd = new FormData();
    fd.set('providerId', providerId);
    fd.set('file', new Blob([readFileSync(file)], { type: 'application/xml' }), 'metadata.xml');
    r = await kc.raw('POST', '/identity-provider/import-config', fd);
  } else {
    r = await kc.raw('POST', '/identity-provider/import-config', { providerId, fromUrl });
  }
  if (!r.ok) throw new Error(`import-config failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function ensureBrokerFlow(kc, alias, tenant, trustEmail, existingIdp) {
  const flow = S.brokerFlowAlias(alias);
  const spec = S.brokerFlowSpec(alias, tenant, trustEmail);
  const flows = await kc.get('/authentication/flows');
  const found = flows.find((f) => f.alias === flow);
  const executions = (f) => kc.get(`/authentication/flows/${enc(f)}/executions`);
  if (found) {
    const ex = await executions(flow);
    if (S.executionsSignature(ex).join('\n') === S.specSignature(spec).join('\n')) {
      await applyFlowConfigs(kc, flow, spec, ex);
      return log('ok', `login flow ${flow}`);
    }
    log('update', `login flow ${flow} differs from the expected shape; recreating`);
    if (existingIdp) await kc.mut('PUT', `/identity-provider/instances/${enc(alias)}`, { ...existingIdp, firstBrokerLoginFlowAlias: 'first broker login' }, 'unbind login flow');
    await kc.mut('DELETE', `/authentication/flows/${found.id}`, undefined, `login flow ${flow}`);
  }
  await kc.mut('POST', '/authentication/flows', { alias: flow, description: `DavraBox SSO first login for ${alias} (tenant ${tenant})`, providerId: 'basic-flow', topLevel: true, builtIn: false }, `login flow ${flow}`);
  const lastFlowAt = [flow];
  for (const node of spec) {
    const parent = lastFlowAt[node.level];
    if (node.type === 'exec') await kc.mut('POST', `/authentication/flows/${enc(parent)}/executions/execution`, { provider: node.provider }, `execution ${node.provider}`);
    else {
      await kc.mut('POST', `/authentication/flows/${enc(parent)}/executions/flow`, { alias: node.alias, type: 'basic-flow', provider: 'registration-page-form', description: 'DavraBox SSO' }, `sub-flow ${node.alias}`);
      lastFlowAt[node.level + 1] = node.alias;
    }
  }
  if (kc.dry) return;
  const ex = await executions(flow);
  if (S.executionsSignature(ex.map((e) => ({ ...e, requirement: '*' }))).join('\n') !== S.specSignature(spec.map((s) => ({ ...s, requirement: '*' }))).join('\n')) {
    throw new Error('login flow was created in an unexpected order');
  }
  await applyFlowConfigs(kc, flow, spec, ex, true);
  log('create', `login flow ${flow}`);
}

async function applyFlowConfigs(kc, flow, spec, ex, setRequirements = false) {
  for (let i = 0; i < spec.length; i++) {
    const want = spec[i];
    const have = ex[i];
    if (setRequirements && have.requirement !== want.requirement) {
      await kc.mut('PUT', `/authentication/flows/${enc(flow)}/executions`, { ...have, requirement: want.requirement }, `requirement ${want.requirement} for ${want.provider ?? want.alias}`);
    }
    if (!want.config) continue;
    if (!have.authenticationConfig) {
      await kc.mut('POST', `/authentication/executions/${have.id}/config`, { alias: want.configAlias, config: want.config }, `config ${want.configAlias}`);
    } else {
      const cur = await kc.get(`/authentication/config/${have.authenticationConfig}`);
      if (S.diffConfig(cur.config, want.config).length) {
        await kc.mut('PUT', `/authentication/config/${have.authenticationConfig}`, { ...cur, alias: want.configAlias, config: want.config }, `config ${want.configAlias}`);
        log('update', `flow config ${want.configAlias}`);
      }
    }
  }
}

async function cmdIdp(kc, kind, cfgRaw, flags, publicUrl) {
  const c = kind === 'oidc' ? S.validateOidcConfig(cfgRaw) : S.validateSamlConfig(cfgRaw);
  const secret = kind === 'oidc' ? process.env[c.clientSecretEnv] : undefined;
  if (kind === 'oidc' && !secret && !flags['dry-run']) throw new S.ConfigError(`environment variable ${c.clientSecretEnv} (client secret) is not set`);
  await requireRoles(kc);

  const existing = await kc.get(`/identity-provider/instances/${enc(c.alias)}`, { allow404: true });
  const existingMappers = existing ? await kc.get(`/identity-provider/instances/${enc(c.alias)}/mappers`) : [];
  if (existing) {
    S.assertTenantUnchanged(S.idpTenant(existingMappers), c.tenant, `identity provider "${c.alias}"`);
    const expectId = kind === 'saml' ? 'saml' : c.provider === 'google' ? 'google' : 'oidc';
    if (existing.providerId !== expectId) throw new Error(`alias "${c.alias}" exists with provider type ${existing.providerId}`);
  }
  const unsafe = S.unsafeOrgSlugMappers(existingMappers);
  if (unsafe.length) throw new Error(`refusing to continue: mapper(s) ${unsafe.map((m) => `"${m.name}"`).join(', ')} write org_slug from the identity provider; delete them (org_slug must stay hardcoded)`);

  let imported = {};
  if (kind === 'oidc' && c.provider !== 'google') imported = await importConfig(kc, 'oidc', { fromUrl: c.discoveryUrl });
  if (kind === 'saml') imported = await importConfig(kc, 'saml', { fromUrl: c.metadataUrl, file: c.metadataFile });
  const desired = kind === 'oidc' ? S.buildOidcIdp(c, imported, secret) : S.buildSamlIdp(c, imported);

  await ensureBrokerFlow(kc, c.alias, c.tenant, c.trustEmail, existing);

  if (!existing) {
    await kc.mut('POST', '/identity-provider/instances', desired, `identity provider ${c.alias}`);
    log('create', `${kind.toUpperCase()} identity provider ${c.alias} (tenant ${c.tenant})`);
  } else {
    const top = ['displayName', 'enabled', 'trustEmail', 'storeToken', 'linkOnly', 'firstBrokerLoginFlowAlias', 'providerId'].filter((k) => String(existing[k]) !== String(desired[k]));
    const cfgChanges = S.diffConfig(existing.config, desired.config, { secretKeys: ['clientSecret'], forceSecrets: flags['force-secrets'] });
    if (top.length || cfgChanges.length) {
      await kc.mut('PUT', `/identity-provider/instances/${enc(c.alias)}`, { ...existing, ...desired, config: { ...existing.config, ...desired.config } }, `identity provider ${c.alias}`);
      log('update', `identity provider ${c.alias} (${[...top, ...cfgChanges].join(', ')})`);
    } else log('ok', `identity provider ${c.alias}`);
  }

  const wantMappers = S.buildIdpMappers(c);
  if (!kc.dry) {
    // An unknown mapper id is stored without complaint and later crashes the login (NullPointerException), so check now.
    const types = await kc.get(`/identity-provider/instances/${enc(c.alias)}/mapper-types`);
    const unknown = [...new Set(wantMappers.map((m) => m.identityProviderMapper))].filter((t) => !types[t]);
    if (unknown.length) throw new Error(`Keycloak has no identity provider mapper type(s) ${unknown.join(', ')} for provider ${desired.providerId}`);
  }
  const plan = S.planNamed(existingMappers, wantMappers, { kindOf: S.idpMapperKind });
  await applyMapperPlan(kc, plan, {
    createPath: `/identity-provider/instances/${enc(c.alias)}/mappers`,
    itemPath: (id) => `/identity-provider/instances/${enc(c.alias)}/mappers/${id}`,
    label: 'IdP mapper',
  });

  console.log(`\nDone. Everybody who signs in through "${c.alias}" belongs to organization "${c.tenant}" (hardcoded), role member${c.adminRule ? ' (org_admin when the admin rule matches)' : ''}.`);
  console.log(`Login hint: add ?kc_idp_hint=${c.alias} to the authorization request (or the button "${c.displayName}" on the login page).`);
  if (kind === 'saml') {
    const sp = S.spInfo(publicUrl, kc.realm, c.alias);
    console.log('\nGive the customer IdP administrator:');
    console.log(`  SP entity ID (Audience)   : ${sp.entityId}`);
    console.log(`  ACS URL (POST binding)    : ${sp.acsUrl}`);
    console.log(`  Single logout URL         : ${sp.singleLogoutUrl}`);
    console.log(`  SP metadata (XML)         : ${sp.metadataUrl}`);
    console.log(`  NameID format             : ${sp.nameIdFormat}`);
  } else {
    console.log(`\nGive the customer IdP administrator the redirect URI: ${publicUrl.replace(/\/+$/, '')}/realms/${kc.realm}/broker/${c.alias}/endpoint`);
  }
}

// ---------- list / remove ----------

async function cmdList(kc) {
  const realm = await kc.get('');
  const feds = (await kc.get(`/components?type=${enc(S.LDAP_COMPONENT)}&parent=${realm.id}`)).filter((x) => x.providerId === 'ldap');
  console.log(`realm ${kc.realm}\n\nLDAP federations (${feds.length})`);
  for (const f of feds) {
    const ms = await kc.get(`/components?parent=${f.id}&type=${enc(S.LDAP_MAPPER_TYPE)}`);
    const tenant = ms.find((m) => m.name === `${S.MANAGED_PREFIX}tenant group`)?.config?.group?.[0]?.replace(/^\/sso-/, '');
    const admin = ms.some((m) => m.name === `${S.MANAGED_PREFIX}admin groups`);
    console.log(`  ${f.name}  ${f.config.connectionUrl?.[0]}  vendor=${f.config.vendor?.[0]}  import=${f.config.importEnabled?.[0]}  tenant=${tenant ?? 'UNMAPPED (users get no org_slug)'}  adminGroupMapper=${admin}  enabled=${f.config.enabled?.[0]}`);
  }
  const idps = await kc.get('/identity-provider/instances');
  console.log(`\nIdentity providers (${idps.length})`);
  for (const i of idps) {
    const ms = await kc.get(`/identity-provider/instances/${enc(i.alias)}/mappers`);
    const tenant = S.idpTenant(ms);
    const unsafe = S.unsafeOrgSlugMappers(ms);
    console.log(`  ${i.alias}  ${i.providerId}  trustEmail=${i.trustEmail}  flow=${i.firstBrokerLoginFlowAlias}  tenant=${tenant ?? 'UNMAPPED (users get no org_slug)'}  kc_idp_hint=${i.alias}  enabled=${i.enabled}${unsafe.length ? '  UNSAFE: ' + unsafe.map((m) => m.name).join(', ') : ''}`);
  }
}

async function cmdRemove(kc, name, flags) {
  if (!name) throw new S.ConfigError('remove needs an identity provider alias or LDAP federation name');
  if (!flags.yes && !flags['dry-run']) throw new S.ConfigError('remove deletes the provider (and for LDAP all imported users); pass --yes to confirm');
  const idp = await kc.get(`/identity-provider/instances/${enc(name)}`, { allow404: true });
  if (idp) {
    await kc.mut('DELETE', `/identity-provider/instances/${enc(name)}`, undefined, `identity provider ${name}`);
    log('remove', `identity provider ${name}`);
    const flow = (await kc.get('/authentication/flows')).find((f) => f.alias === S.brokerFlowAlias(name));
    if (flow) {
      await kc.mut('DELETE', `/authentication/flows/${flow.id}`, undefined, `login flow ${flow.alias}`);
      log('remove', `login flow ${flow.alias}`);
    }
    return;
  }
  const realm = await kc.get('');
  const fed = (await kc.get(`/components?type=${enc(S.LDAP_COMPONENT)}&parent=${realm.id}`)).find((x) => x.name === name && x.providerId === 'ldap');
  if (!fed) throw new Error(`no identity provider or LDAP federation named "${name}"`);
  const ms = await kc.get(`/components?parent=${fed.id}&type=${enc(S.LDAP_MAPPER_TYPE)}`);
  const tenant = ms.find((m) => m.name === `${S.MANAGED_PREFIX}tenant group`)?.config?.group?.[0]?.replace(/^\/sso-/, '');
  await kc.mut('DELETE', `/components/${fed.id}`, undefined, `federation ${name}`);
  log('remove', `LDAP federation ${name} (imported users are deleted with it)`);
  if (tenant) {
    const others = (await kc.get(`/components?type=${enc(S.LDAP_COMPONENT)}&parent=${realm.id}`)).filter((x) => x.id !== fed.id && x.providerId === 'ldap');
    let shared = false;
    for (const o of others) {
      const om = await kc.get(`/components?parent=${o.id}&type=${enc(S.LDAP_MAPPER_TYPE)}`);
      if (om.some((m) => m.name === `${S.MANAGED_PREFIX}tenant group` && m.config?.group?.[0] === S.tenantGroupPath(tenant))) shared = true;
    }
    const g = (await kc.get(`/groups?search=${enc(S.tenantGroupName(tenant))}&exact=true`)).find((x) => x.name === S.tenantGroupName(tenant));
    if (g && !shared) {
      await kc.mut('DELETE', `/groups/${g.id}`, undefined, `group ${g.name}`);
      log('remove', `group /${g.name}`);
    }
  }
}

// ---------- main ----------

async function main() {
  const { cmd, arg, flags } = parseCli(process.argv.slice(2));
  if (!['ldap', 'oidc', 'saml', 'list', 'remove'].includes(cmd)) throw new S.ConfigError(USAGE);
  const base = process.env.KEYCLOAK_URL ?? 'http://127.0.0.1:8180/auth';
  const kc = new Admin(base, flags.realm, flags['dry-run']);
  const cfg = ['ldap', 'oidc', 'saml'].includes(cmd) ? loadConfig(flags) : undefined;
  if (cfg) {
    // Validate before any network call so config errors never need credentials.
    (cmd === 'ldap' ? S.validateLdapConfig : cmd === 'oidc' ? S.validateOidcConfig : S.validateSamlConfig)(cfg);
  }
  await kc.login();
  if (cmd === 'ldap') await cmdLdap(kc, cfg, flags);
  else if (cmd === 'oidc' || cmd === 'saml') await cmdIdp(kc, cmd, cfg, flags, process.env.KEYCLOAK_PUBLIC_URL ?? base);
  else if (cmd === 'list') await cmdList(kc);
  else await cmdRemove(kc, arg, flags);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`${e instanceof S.ConfigError ? 'config error' : 'error'}: ${e.message}`);
    // exitCode, not process.exit(): exiting with sockets still closing trips a libuv assertion on Windows.
    process.exitCode = e instanceof S.ConfigError ? 2 : 1;
  });
}
