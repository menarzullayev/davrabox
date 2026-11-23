// Pure helpers for scripts/keycloak-sso.mjs: config validation, representation builders and idempotent
// diffing. No I/O and no network, so everything here is unit-testable (scripts/lib/sso.test.mjs).
//
// Tenant model: ONE organization (tenant) per identity provider / LDAP federation. The tenant slug is
// written into the token claim `org_slug` from a HARDCODED value stored in Keycloak (a hardcoded IdP
// attribute mapper, or a group attribute for LDAP). It never comes from the external system, and no
// configuration that could copy an external value into `org_slug` is accepted.

export class ConfigError extends Error {}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/; // same rule as apps/api/src/auth/jwt.ts
export const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
export const MANAGED_PREFIX = 'davra: '; // mappers created by this tool; only these are ever deleted by it
export const MASK = '**********'; // what the Keycloak admin API returns instead of secrets
export const ROLE_ADMIN = 'org_admin';
export const ROLE_MEMBER = 'member';
export const RESERVED_ATTRIBUTES = ['org_slug'];
export const LDAP_COMPONENT = 'org.keycloak.storage.UserStorageProvider';
export const LDAP_MAPPER_TYPE = 'org.keycloak.storage.ldap.mappers.LDAPStorageMapper';

const SECRETISH = /(secret|password|passwd|credential|token|private)/i;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

// ---------- generic validation helpers ----------

/** Rejects any key that looks like it holds a secret; only `<something>Env` keys naming an env var are allowed. */
export function rejectSecrets(obj, path = '') {
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    const here = path ? `${path}.${k}` : k;
    if (SECRETISH.test(k)) {
      if (!k.endsWith('Env')) throw new ConfigError(`${here}: secrets must not be put in the config file; use a "${k}Env" key naming an environment variable`);
      if (typeof v !== 'string' || !ENV_NAME.test(v)) throw new ConfigError(`${here}: must be an environment variable name such as SSO_LDAP_BIND_CREDENTIAL`);
    }
    if (v && typeof v === 'object') rejectSecrets(v, here);
  }
}

function reader(cfg, known) {
  const unknown = Object.keys(cfg).filter((k) => !known.includes(k));
  if (unknown.length) throw new ConfigError(`unknown config key(s): ${unknown.join(', ')}`);
  return {
    str(key, { required = false, def, pattern, oneOf } = {}) {
      let v = cfg[key];
      if (v === undefined || v === null || v === '') {
        if (required) throw new ConfigError(`${key} is required`);
        return def;
      }
      if (typeof v !== 'string') throw new ConfigError(`${key} must be a string`);
      v = v.trim();
      if (pattern && !pattern.test(v)) throw new ConfigError(`${key} has an invalid format`);
      if (oneOf && !oneOf.includes(v)) throw new ConfigError(`${key} must be one of: ${oneOf.join(', ')}`);
      return v;
    },
    bool(key, def) {
      const v = cfg[key];
      if (v === undefined) return def;
      if (typeof v !== 'boolean') throw new ConfigError(`${key} must be true or false`);
      return v;
    },
    int(key, def, { min = -1, max = 31_536_000 } = {}) {
      const v = cfg[key];
      if (v === undefined) return def;
      if (!Number.isInteger(v) || v < min || v > max) throw new ConfigError(`${key} must be an integer between ${min} and ${max}`);
      return v;
    },
    list(key, def = []) {
      const v = cfg[key];
      if (v === undefined) return def;
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) throw new ConfigError(`${key} must be a list of non-empty strings`);
      return v.map((x) => x.trim());
    },
  };
}

function tenantOf(r) {
  const t = r.str('tenant', { required: true });
  if (!SLUG_RE.test(t)) throw new ConfigError('tenant must match ^[a-z0-9][a-z0-9-]{1,62}$ (the organization slug used in the org_slug claim)');
  return t;
}

function aliasOf(r, def) {
  const a = r.str('alias', { def });
  if (!ALIAS_RE.test(a)) throw new ConfigError('alias must match ^[a-z0-9][a-z0-9._-]{0,62}$');
  return a;
}

function needHttps(url, field, allowInsecure) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new ConfigError(`${field} is not a valid URL`);
  }
  if (u.protocol !== 'https:' && !(allowInsecure && u.protocol === 'http:')) throw new ConfigError(`${field} must use https (set allowInsecureHttp only for local tests)`);
  return u.toString();
}

/** RFC 4515 escaping for a value placed inside an LDAP filter. */
export function ldapFilterEscape(v) {
  return String(v).replace(/[\\*()\0]/g, (c) => '\\' + c.charCodeAt(0).toString(16).padStart(2, '0'));
}

/** Claims/attributes an external system may feed into user attributes; org_slug is never one of them. */
export function checkMappingTargets(map, field) {
  for (const [from, to] of Object.entries(map)) {
    if (typeof to !== 'string' || !to) throw new ConfigError(`${field}.${from}: target attribute must be a non-empty string`);
    if (RESERVED_ATTRIBUTES.includes(to.toLowerCase()) || RESERVED_ATTRIBUTES.includes(from.toLowerCase())) {
      throw new ConfigError(`${field}: the organization (org_slug) is fixed by "tenant" and can never be mapped from the identity provider`);
    }
  }
}

function ruleOf(cfg, field, keyName) {
  const rule = cfg[field];
  if (rule === undefined) return undefined;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new ConfigError(`${field} must be an object { ${keyName}, value }`);
  const extra = Object.keys(rule).filter((k) => ![keyName, 'value'].includes(k));
  if (extra.length) throw new ConfigError(`${field}: unknown key(s) ${extra.join(', ')}`);
  for (const k of [keyName, 'value']) if (typeof rule[k] !== 'string' || !rule[k].trim()) throw new ConfigError(`${field}.${k} is required`);
  return { [keyName]: rule[keyName].trim(), value: rule.value.trim() };
}

// ---------- LDAP / Active Directory ----------

const LDAP_KEYS = [
  'tenant', 'name', 'vendor', 'connectionUrl', 'startTls', 'allowInsecureLdap', 'bindDn', 'bindCredentialEnv', 'usersDn',
  'usernameAttribute', 'rdnAttribute', 'uuidAttribute', 'emailAttribute', 'firstNameAttribute', 'lastNameAttribute',
  'userObjectClasses', 'userFilter', 'searchScope', 'importUsers', 'connectionPooling', 'fullSyncPeriod', 'changedSyncPeriod',
  'trustEmail', 'cacheMaxLifespanSeconds', 'adminGroups', 'groupsDn', 'groupObjectClass', 'groupMemberAttribute', 'priority', 'connectionTimeoutMs', 'readTimeoutMs',
];

const LDAP_VENDOR_DEFAULTS = {
  ad: {
    usernameAttribute: 'sAMAccountName', rdnAttribute: 'cn', uuidAttribute: 'objectGUID', emailAttribute: 'mail', firstNameAttribute: 'givenName', lastNameAttribute: 'sn',
    userObjectClasses: ['person', 'organizationalPerson', 'user'], groupObjectClass: 'group', groupMemberAttribute: 'member',
  },
  other: {
    usernameAttribute: 'uid', rdnAttribute: 'uid', uuidAttribute: 'entryUUID', emailAttribute: 'mail', firstNameAttribute: 'givenName', lastNameAttribute: 'sn',
    userObjectClasses: ['inetOrgPerson', 'organizationalPerson'], groupObjectClass: 'groupOfNames', groupMemberAttribute: 'member',
  },
};

export function validateLdapConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('config must be a JSON object');
  rejectSecrets(raw);
  const r = reader(raw, LDAP_KEYS);
  const tenant = tenantOf(r);
  const vendor = r.str('vendor', { def: 'other', oneOf: ['ad', 'other'] });
  const d = LDAP_VENDOR_DEFAULTS[vendor];
  const connectionUrl = r.str('connectionUrl', { required: true });
  if (!/^ldaps?:\/\/[^\s/]+(:\d+)?$/.test(connectionUrl)) throw new ConfigError('connectionUrl must look like ldaps://host:636 or ldap://host:389');
  const startTls = r.bool('startTls', false);
  const allowInsecureLdap = r.bool('allowInsecureLdap', false);
  if (connectionUrl.startsWith('ldap://') && !startTls && !allowInsecureLdap) {
    throw new ConfigError('plain ldap:// without startTls would send the bind password in clear text; use ldaps://, set startTls, or allowInsecureLdap for a local test');
  }
  if (connectionUrl.startsWith('ldaps://') && startTls) throw new ConfigError('startTls cannot be combined with ldaps://');
  const dn = (key, required) => {
    const v = r.str(key, { required });
    if (v !== undefined && !/^[^=,]+=[^,]+(,\s*[^=,]+=[^,]+)*$/.test(v)) throw new ConfigError(`${key} is not a valid DN`);
    return v;
  };
  const adminGroups = r.list('adminGroups');
  if (adminGroups.some((g) => /[\0]/.test(g))) throw new ConfigError('adminGroups contains an invalid character');
  const out = {
    kind: 'ldap',
    tenant,
    name: r.str('name', { def: `ldap-${tenant}` }),
    vendor,
    connectionUrl,
    startTls,
    allowInsecureLdap,
    bindDn: dn('bindDn', true),
    bindCredentialEnv: r.str('bindCredentialEnv', { def: 'SSO_LDAP_BIND_CREDENTIAL' }),
    usersDn: dn('usersDn', true),
    usernameAttribute: r.str('usernameAttribute', { def: d.usernameAttribute }),
    rdnAttribute: r.str('rdnAttribute', { def: d.rdnAttribute }),
    uuidAttribute: r.str('uuidAttribute', { def: d.uuidAttribute }),
    emailAttribute: r.str('emailAttribute', { def: d.emailAttribute }),
    firstNameAttribute: r.str('firstNameAttribute', { def: d.firstNameAttribute }),
    lastNameAttribute: r.str('lastNameAttribute', { def: d.lastNameAttribute }),
    userObjectClasses: r.list('userObjectClasses', d.userObjectClasses),
    userFilter: r.str('userFilter'),
    searchScope: r.str('searchScope', { def: 'onelevel', oneOf: ['onelevel', 'subtree'] }),
    importUsers: r.bool('importUsers', true),
    connectionPooling: r.bool('connectionPooling', true),
    fullSyncPeriod: r.int('fullSyncPeriod', 86400),
    changedSyncPeriod: r.int('changedSyncPeriod', 600),
    trustEmail: r.bool('trustEmail', false),
    cacheMaxLifespanSeconds: r.int('cacheMaxLifespanSeconds', 600, { min: 0, max: 86400 }),
    adminGroups,
    groupsDn: r.str('groupsDn'),
    groupObjectClass: r.str('groupObjectClass', { def: d.groupObjectClass }),
    groupMemberAttribute: r.str('groupMemberAttribute', { def: d.groupMemberAttribute }),
    priority: r.int('priority', 0, { min: 0, max: 1000 }),
    connectionTimeoutMs: r.int('connectionTimeoutMs', 10000, { min: 1000, max: 120000 }),
    readTimeoutMs: r.int('readTimeoutMs', 30000, { min: 1000, max: 300000 }),
  };
  if (!ENV_NAME.test(out.bindCredentialEnv)) throw new ConfigError('bindCredentialEnv must be an environment variable name');
  if (/[=,]/.test(out.name) || out.name.length > 100) throw new ConfigError('name must not contain "," or "=" and be at most 100 characters');
  if (out.userFilter !== undefined && !/^\(.*\)$/.test(out.userFilter)) throw new ConfigError('userFilter must be a parenthesised LDAP filter such as (!(employeeType=suspended))');
  if (adminGroups.length && !out.groupsDn) throw new ConfigError('groupsDn is required when adminGroups is set');
  if (out.groupsDn && !/=/.test(out.groupsDn)) throw new ConfigError('groupsDn is not a valid DN');
  return out;
}

export const tenantGroupName = (tenant) => `sso-${tenant}`;
export const tenantGroupPath = (tenant) => `/${tenantGroupName(tenant)}`;

/** Keycloak user-storage component for the federation. `secret` is injected by the CLI from the environment. */
export function buildLdapComponent(c, realmId, secret) {
  const filter = c.userFilter ? { customUserSearchFilter: [c.userFilter] } : {};
  return {
    name: c.name,
    providerId: 'ldap',
    providerType: LDAP_COMPONENT,
    parentId: realmId,
    config: {
      enabled: ['true'],
      priority: [String(c.priority)],
      editMode: ['READ_ONLY'],
      vendor: [c.vendor],
      usernameLDAPAttribute: [c.usernameAttribute],
      rdnLDAPAttribute: [c.rdnAttribute],
      uuidLDAPAttribute: [c.uuidAttribute],
      userObjectClasses: [c.userObjectClasses.join(', ')],
      connectionUrl: [c.connectionUrl],
      usersDn: [c.usersDn],
      authType: ['simple'],
      bindDn: [c.bindDn],
      ...(secret !== undefined ? { bindCredential: [secret] } : {}),
      searchScope: [c.searchScope === 'subtree' ? '2' : '1'],
      startTls: [String(c.startTls)],
      useTruststoreSpi: ['ldapsOnly'],
      connectionPooling: [String(c.connectionPooling)],
      connectionTimeout: [String(c.connectionTimeoutMs)],
      readTimeout: [String(c.readTimeoutMs)],
      pagination: ['true'],
      batchSizeForSync: ['1000'],
      importEnabled: [String(c.importUsers)],
      syncRegistrations: ['false'],
      validatePasswordPolicy: ['false'],
      trustEmail: [String(c.trustEmail)],
      fullSyncPeriod: [String(c.importUsers ? c.fullSyncPeriod : -1)],
      changedSyncPeriod: [String(c.importUsers ? c.changedSyncPeriod : -1)],
      // Group membership (hence org_admin) is cached with the user; MAX_LIFESPAN bounds how stale it can get.
      ...(c.cacheMaxLifespanSeconds === 0 ? { cachePolicy: ['NO_CACHE'] } : { cachePolicy: ['MAX_LIFESPAN'], maxLifespan: [String(c.cacheMaxLifespanSeconds * 1000)] }),
      ...filter,
    },
  };
}

/** Desired LDAP mappers. Default Keycloak mappers (username, email, ...) keep their names and are updated in place. */
export function buildLdapMappers(c, parentId) {
  const mk = (name, providerId, config) => ({ name, providerId, providerType: LDAP_MAPPER_TYPE, parentId, config });
  const attr = (name, model, ldap, mandatory, live) =>
    mk(name, 'user-attribute-ldap-mapper', {
      'user.model.attribute': [model], 'ldap.attribute': [ldap], 'read.only': ['true'], 'always.read.value.from.ldap': [String(live)], 'is.mandatory.in.ldap': [String(mandatory)],
    });
  for (const [label, model] of [['username', c.usernameAttribute], ['email', c.emailAttribute], ['first name', c.firstNameAttribute], ['last name', c.lastNameAttribute]]) {
    if (RESERVED_ATTRIBUTES.includes(String(model).toLowerCase())) throw new ConfigError(`${label}: LDAP attributes can never be mapped to org_slug`);
  }
  const out = [
    attr('username', 'username', c.usernameAttribute, true, false),
    attr('email', 'email', c.emailAttribute, false, true),
    attr('first name', 'firstName', c.firstNameAttribute, false, true),
    attr('last name', 'lastName', c.lastNameAttribute, false, true),
    // Every user of this federation becomes a member of the tenant group, which carries org_slug and role member.
    mk(`${MANAGED_PREFIX}tenant group`, 'hardcoded-ldap-group-mapper', { group: [tenantGroupPath(c.tenant)] }),
  ];
  if (c.adminGroups.length) {
    const cn = c.adminGroups.map((g) => `(cn=${ldapFilterEscape(g)})`);
    out.push(
      mk(`${MANAGED_PREFIX}admin groups`, 'group-ldap-mapper', {
        'groups.dn': [c.groupsDn],
        'group.name.ldap.attribute': ['cn'],
        'group.object.classes': [c.groupObjectClass],
        'preserve.group.inheritance': ['false'],
        'membership.ldap.attribute': [c.groupMemberAttribute],
        'membership.attribute.type': ['DN'],
        'membership.user.ldap.attribute': [c.usernameAttribute],
        'groups.ldap.filter': [cn.length === 1 ? cn[0] : `(|${cn.join('')})`],
        mode: ['READ_ONLY'],
        'user.roles.retrieve.strategy': ['LOAD_GROUPS_BY_MEMBER_ATTRIBUTE'],
        // false: a re-sync must never delete the pre-created group that carries the org_admin role mapping.
        'drop.non.existing.groups.during.sync': ['false'],
        'groups.path': [tenantGroupPath(c.tenant)],
        'mapped.group.attributes': [''],
        'ignore.missing.groups': ['false'],
      }),
    );
  }
  return out;
}

// ---------- OIDC identity providers ----------

const OIDC_KEYS = [
  'tenant', 'alias', 'provider', 'displayName', 'discoveryUrl', 'azureTenantId', 'oktaDomain', 'oktaAuthorizationServer', 'hostedDomain', 'clientId', 'clientSecretEnv',
  'scopes', 'trustEmail', 'claimMappings', 'adminRule', 'hideOnLogin', 'allowInsecureHttp',
];
const GUID = /^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/;
const DOMAIN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

export function validateOidcConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('config must be a JSON object');
  rejectSecrets(raw);
  const r = reader(raw, OIDC_KEYS);
  const tenant = tenantOf(r);
  const provider = r.str('provider', { def: 'generic', oneOf: ['generic', 'entra', 'google', 'okta'] });
  const allowInsecureHttp = r.bool('allowInsecureHttp', false);
  let discoveryUrl;
  if (provider === 'entra') {
    const t = r.str('azureTenantId', { required: true });
    if (!GUID.test(t) && !DOMAIN.test(t)) throw new ConfigError('azureTenantId must be the directory (tenant) GUID or its primary domain; "common"/"organizations" are refused because they accept any directory');
    discoveryUrl = `https://login.microsoftonline.com/${t}/v2.0/.well-known/openid-configuration`;
  } else if (provider === 'okta') {
    const d = r.str('oktaDomain', { required: true });
    if (!DOMAIN.test(d)) throw new ConfigError('oktaDomain must be a host name such as example.okta.com');
    const server = r.str('oktaAuthorizationServer', { def: 'default', pattern: /^[A-Za-z0-9_-]+$/ });
    discoveryUrl = server === 'org' ? `https://${d}/.well-known/openid-configuration` : `https://${d}/oauth2/${server}/.well-known/openid-configuration`;
  } else if (provider === 'generic') {
    discoveryUrl = needHttps(r.str('discoveryUrl', { required: true }), 'discoveryUrl', allowInsecureHttp);
  }
  const hostedDomain = r.str('hostedDomain');
  if (provider === 'google') {
    if (!hostedDomain || !DOMAIN.test(hostedDomain)) throw new ConfigError('hostedDomain (the Google Workspace domain) is required for google: without it any Google account could sign in');
  } else if (hostedDomain) throw new ConfigError('hostedDomain only applies to provider google');
  const claimMappings = raw.claimMappings ?? (provider === 'google' ? {} : { email: 'email', given_name: 'firstName', family_name: 'lastName' });
  if (typeof claimMappings !== 'object' || Array.isArray(claimMappings)) throw new ConfigError('claimMappings must be an object { claim: userAttribute }');
  checkMappingTargets(claimMappings, 'claimMappings');
  const adminRule = ruleOf(raw, 'adminRule', 'claim');
  if (provider === 'google' && (adminRule || Object.keys(claimMappings).length)) throw new ConfigError('provider google does not support claimMappings/adminRule (Google sends no group claims); grant org_admin in Keycloak instead');
  if (adminRule && RESERVED_ATTRIBUTES.includes(adminRule.claim.toLowerCase())) throw new ConfigError('adminRule.claim must not be org_slug');
  const alias = aliasOf(r, `${provider === 'generic' ? 'oidc' : provider}-${tenant}`);
  return {
    kind: 'oidc',
    tenant,
    alias,
    provider,
    displayName: r.str('displayName', { def: alias }),
    discoveryUrl,
    hostedDomain,
    clientId: r.str('clientId', { required: true }),
    clientSecretEnv: r.str('clientSecretEnv', { def: 'SSO_OIDC_CLIENT_SECRET' }),
    scopes: r.str('scopes', { def: provider === 'okta' ? 'openid email profile groups' : 'openid email profile' }),
    trustEmail: r.bool('trustEmail', false),
    claimMappings,
    adminRule,
    hideOnLogin: r.bool('hideOnLogin', false),
    allowInsecureHttp,
  };
}

/** `imported` is the result of Keycloak's import-config for the discovery URL (endpoints, issuer, jwks). */
export function buildOidcIdp(c, imported, secret) {
  const common = { syncMode: 'FORCE', hideOnLogin: String(c.hideOnLogin), guiOrder: '' };
  const config =
    c.provider === 'google'
      ? { ...common, clientId: c.clientId, ...(secret !== undefined ? { clientSecret: secret } : {}), hostedDomain: c.hostedDomain, defaultScope: c.scopes, useHostedDomain: 'true' }
      : {
          ...common,
          ...pick(imported, ['authorizationUrl', 'tokenUrl', 'userInfoUrl', 'jwksUrl', 'logoutUrl', 'issuer']),
          clientId: c.clientId,
          ...(secret !== undefined ? { clientSecret: secret } : {}),
          clientAuthMethod: 'client_secret_post',
          defaultScope: c.scopes,
          validateSignature: 'true',
          useJwksUrl: 'true',
          pkceEnabled: 'true',
          pkceMethod: 'S256',
        };
  if (c.provider !== 'google' && (!config.authorizationUrl || !config.tokenUrl || !config.jwksUrl)) {
    throw new ConfigError('discovery document lacks authorization/token/jwks endpoints; refusing to create an IdP that cannot validate signatures');
  }
  return {
    alias: c.alias,
    displayName: c.displayName,
    providerId: c.provider === 'google' ? 'google' : 'oidc',
    enabled: true,
    trustEmail: c.trustEmail,
    storeToken: false,
    addReadTokenRoleOnCreate: false,
    linkOnly: false,
    firstBrokerLoginFlowAlias: brokerFlowAlias(c.alias),
    config,
  };
}

function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== '') out[k] = String(o[k]);
  return out;
}

// ---------- SAML identity providers ----------

const SAML_KEYS = [
  'tenant', 'alias', 'displayName', 'preset', 'metadataUrl', 'metadataFile', 'nameIdFormat', 'attributeNames', 'adminRule', 'trustEmail',
  'signAuthnRequests', 'hideOnLogin', 'forceAuthn', 'allowInsecureHttp',
];
const NAMEID = {
  email: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  persistent: 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent',
  transient: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient',
  unspecified: 'urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified',
};
const MS_CLAIMS = {
  email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  firstName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
  lastName: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
};
export const SAML_PRESETS = {
  generic: { email: 'email', firstName: 'firstName', lastName: 'lastName' },
  okta: { email: 'email', firstName: 'firstName', lastName: 'lastName' },
  adfs: MS_CLAIMS,
  entra: MS_CLAIMS,
};

export function validateSamlConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('config must be a JSON object');
  rejectSecrets(raw);
  const r = reader(raw, SAML_KEYS);
  const tenant = tenantOf(r);
  const preset = r.str('preset', { def: 'generic', oneOf: Object.keys(SAML_PRESETS) });
  const allowInsecureHttp = r.bool('allowInsecureHttp', false);
  const metadataUrl = r.str('metadataUrl');
  const metadataFile = r.str('metadataFile');
  if (!!metadataUrl === !!metadataFile) throw new ConfigError('exactly one of metadataUrl or metadataFile is required');
  const names = { ...SAML_PRESETS[preset], ...(raw.attributeNames ?? {}) };
  if (typeof names !== 'object' || Object.keys(names).some((k) => !['email', 'firstName', 'lastName'].includes(k))) throw new ConfigError('attributeNames supports only email, firstName, lastName');
  for (const v of Object.values(names)) if (typeof v !== 'string' || !v) throw new ConfigError('attributeNames values must be non-empty strings');
  if (Object.values(names).some((v) => RESERVED_ATTRIBUTES.includes(v.toLowerCase()))) throw new ConfigError('the organization (org_slug) can never be mapped from a SAML attribute');
  const adminRule = ruleOf(raw, 'adminRule', 'attribute');
  if (adminRule && RESERVED_ATTRIBUTES.includes(adminRule.attribute.toLowerCase())) throw new ConfigError('adminRule.attribute must not be org_slug');
  const alias = aliasOf(r, `saml-${tenant}`);
  return {
    kind: 'saml',
    tenant,
    alias,
    displayName: r.str('displayName', { def: alias }),
    preset,
    metadataUrl: metadataUrl ? needHttps(metadataUrl, 'metadataUrl', allowInsecureHttp) : undefined,
    metadataFile,
    nameIdFormat: r.str('nameIdFormat', { def: 'email', oneOf: Object.keys(NAMEID) }),
    attributeNames: names,
    adminRule,
    trustEmail: r.bool('trustEmail', false),
    signAuthnRequests: r.bool('signAuthnRequests', false),
    hideOnLogin: r.bool('hideOnLogin', false),
    forceAuthn: r.bool('forceAuthn', false),
    allowInsecureHttp,
  };
}

/** `imported` is Keycloak's import-config result for the IdP metadata. Signature validation is always on. */
export function buildSamlIdp(c, imported) {
  if (!imported || !imported.singleSignOnServiceUrl) throw new ConfigError('metadata has no SingleSignOnService endpoint');
  if (!imported.signingCertificate) throw new ConfigError('metadata has no signing certificate; refusing to create a SAML IdP that cannot validate signatures');
  return {
    alias: c.alias,
    displayName: c.displayName,
    providerId: 'saml',
    enabled: true,
    trustEmail: c.trustEmail,
    storeToken: false,
    addReadTokenRoleOnCreate: false,
    linkOnly: false,
    firstBrokerLoginFlowAlias: brokerFlowAlias(c.alias),
    config: {
      // idpEntityId is the IdP's issuer; "entityId" would be OUR service provider id and is left at Keycloak's default.
      ...pick(imported, ['singleSignOnServiceUrl', 'singleLogoutServiceUrl', 'idpEntityId', 'signingCertificate']),
      syncMode: 'FORCE',
      hideOnLogin: String(c.hideOnLogin),
      nameIDPolicyFormat: NAMEID[c.nameIdFormat],
      principalType: 'SUBJECT',
      validateSignature: 'true',
      wantAssertionsSigned: 'true',
      wantAssertionsEncrypted: 'false',
      wantAuthnRequestsSigned: String(c.signAuthnRequests),
      signatureAlgorithm: 'RSA_SHA256',
      postBindingAuthnRequest: 'true',
      postBindingResponse: 'true',
      postBindingLogout: 'true',
      allowCreate: 'true',
      forceAuthn: String(c.forceAuthn),
    },
  };
}

/** What a customer's IdP administrator needs to register DavraBox as a SAML service provider. */
export function spInfo(base, realm, alias) {
  const root = `${base.replace(/\/+$/, '')}/realms/${realm}`;
  return {
    entityId: root,
    acsUrl: `${root}/broker/${alias}/endpoint`,
    metadataUrl: `${root}/broker/${alias}/endpoint/descriptor`,
    singleLogoutUrl: `${root}/broker/${alias}/endpoint`,
    nameIdFormat: NAMEID.email,
  };
}

// ---------- identity provider mappers ----------

export const brokerFlowAlias = (alias) => `sso-broker-${alias}`;

/** Mappers for an IdP. org_slug is HARDCODED; role rules only ever grant org_admin from an explicit rule. */
export function buildIdpMappers(c) {
  const m = (name, identityProviderMapper, config) => ({ name: MANAGED_PREFIX + name, identityProviderAlias: c.alias, identityProviderMapper, config: { syncMode: 'FORCE', ...config } });
  const out = [
    m('org_slug', 'hardcoded-attribute-idp-mapper', { attribute: 'org_slug', 'attribute.value': c.tenant }),
    m('default role', 'oidc-hardcoded-role-idp-mapper', { role: ROLE_MEMBER }),
  ];
  if (c.kind === 'oidc' && c.provider !== 'google') {
    for (const [claim, attr] of Object.entries(c.claimMappings)) out.push(m(`claim ${claim}`, 'oidc-user-attribute-idp-mapper', { claim, 'user.attribute': attr }));
    if (c.adminRule) out.push(m('admin role', 'oidc-role-idp-mapper', { claim: c.adminRule.claim, 'claim.value': c.adminRule.value, role: ROLE_ADMIN }));
  }
  if (c.kind === 'saml') {
    for (const [key, name] of Object.entries(c.attributeNames)) out.push(m(`attribute ${key}`, 'saml-user-attribute-idp-mapper', { 'attribute.name': name, 'user.attribute': key }));
    if (c.adminRule) out.push(m('admin role', 'saml-role-idp-mapper', { 'attribute.name': c.adminRule.attribute, 'attribute.value': c.adminRule.value, role: ROLE_ADMIN }));
  }
  return out;
}

// ---------- first broker login flow ----------

/**
 * Flat description (level, kind, requirement) of the per-IdP first-broker-login flow:
 *   - no profile review page;
 *   - unknown email -> account created;
 *   - known email and trustEmail -> auto-linked, but only if that existing account already belongs to THIS tenant
 *     (otherwise one customer's IdP could take over an account of another tenant by asserting its email);
 *   - known email and not trustEmail -> refused (email not trusted, so no silent link).
 */
export function brokerFlowSpec(alias, tenant, trustEmail) {
  const flow = brokerFlowAlias(alias);
  const deny = (msg) => ({ level: 1, type: 'exec', provider: 'deny-access-authenticator', requirement: 'REQUIRED', configAlias: `${flow} deny`, config: { denyErrorMessage: msg } });
  const spec = [
    { level: 0, type: 'exec', provider: 'idp-create-user-if-unique', requirement: 'ALTERNATIVE' },
    { level: 0, type: 'flow', alias: `${flow} link existing`, requirement: 'ALTERNATIVE' },
  ];
  if (trustEmail) {
    spec.push(
      { level: 1, type: 'exec', provider: 'idp-auto-link', requirement: 'REQUIRED' },
      { level: 1, type: 'flow', alias: `${flow} tenant guard`, requirement: 'CONDITIONAL' },
      { level: 2, type: 'exec', provider: 'conditional-user-attribute', requirement: 'REQUIRED', configAlias: `${flow} other tenant`, config: { attribute_name: 'org_slug', attribute_expected_value: tenant, not: 'true' } },
      { level: 2, type: 'exec', provider: 'deny-access-authenticator', requirement: 'REQUIRED', configAlias: `${flow} deny`, config: { denyErrorMessage: 'This email address belongs to another organization.' } },
    );
  } else {
    spec.push(deny('An account with this email already exists and the identity provider email is not trusted. Ask your administrator to link it.'));
  }
  return spec;
}

/** Comparable signature of the spec or of the executions Keycloak reports, to detect drift. */
export const specSignature = (spec) => spec.map((e) => `${e.level}|${e.type === 'flow' ? 'flow:' + e.alias : e.provider}|${e.requirement}`);
export const executionsSignature = (executions) =>
  executions.map((e) => `${e.level}|${e.authenticationFlow ? 'flow:' + e.displayName : e.providerId}|${e.requirement}`);

// ---------- idempotent diffing ----------

const norm = (v) => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]);

/**
 * Keys whose desired value differs from the existing config. Extra keys in `existing` (Keycloak defaults) are
 * ignored. A secret key whose stored value is masked cannot be compared and counts as unchanged unless
 * `forceSecrets` is set.
 */
export function diffConfig(existing = {}, desired = {}, { secretKeys = [], forceSecrets = false } = {}) {
  const changed = [];
  for (const [k, want] of Object.entries(desired)) {
    const have = existing[k];
    if (secretKeys.includes(k)) {
      const haveMasked = norm(have).every((x) => x === MASK);
      if (haveMasked && !forceSecrets) continue;
    }
    if (norm(have).join('\u0000') !== norm(want).join('\u0000')) changed.push(k);
  }
  return changed;
}

/**
 * Plans mapper changes by name. Kind change = remove + create. Mappers carrying MANAGED_PREFIX that are no longer
 * desired are removed (so dropping adminRule revokes the mapping); other existing mappers are never touched.
 */
export function planNamed(existing, desired, { kindOf, configOf = (x) => x.config, secretKeys = [] } = {}) {
  const plan = { create: [], update: [], remove: [], same: [] };
  const byName = new Map(existing.map((e) => [e.name, e]));
  for (const want of desired) {
    const have = byName.get(want.name);
    byName.delete(want.name);
    if (!have) plan.create.push(want);
    else if (kindOf(have) !== kindOf(want)) {
      plan.remove.push(have);
      plan.create.push(want);
    } else {
      const changes = diffConfig(configOf(have), configOf(want), { secretKeys });
      if (changes.length) plan.update.push({ existing: have, desired: want, changes });
      else plan.same.push(want);
    }
  }
  for (const stale of byName.values()) if (stale.name.startsWith(MANAGED_PREFIX)) plan.remove.push(stale);
  return plan;
}

export const idpMapperKind = (m) => m.identityProviderMapper;
export const ldapMapperKind = (m) => m.providerId;

/** Refuses to move an existing alias/federation to a different tenant. */
export function assertTenantUnchanged(existingTenant, wantedTenant, what) {
  if (existingTenant && existingTenant !== wantedTenant) {
    throw new ConfigError(`${what} is already bound to tenant "${existingTenant}"; one provider serves exactly one organization. Remove it first (remove <alias>) to rebind it.`);
  }
}

/** Reads the tenant a provider is bound to from its mappers (IdP) -- used by `list` and the rebinding guard. */
export function idpTenant(mappers) {
  const m = mappers.find((x) => x.identityProviderMapper === 'hardcoded-attribute-idp-mapper' && norm(x.config?.attribute)[0] === 'org_slug');
  return m ? norm(m.config['attribute.value'])[0] : undefined;
}

/** True when some IdP mapper writes org_slug from anything other than our hardcoded mapper. */
export function unsafeOrgSlugMappers(mappers) {
  return mappers.filter((x) => {
    if (x.name?.startsWith(MANAGED_PREFIX + 'org_slug')) return false;
    const c = x.config ?? {};
    return ['attribute', 'user.attribute', 'attribute.name', 'claim'].some((k) => RESERVED_ATTRIBUTES.includes(String(c[k] ?? '').toLowerCase()));
  });
}
