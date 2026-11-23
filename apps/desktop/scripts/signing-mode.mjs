// Pure secret-detection logic of the desktop release pipeline (no I/O, unit-tested in test/signing-mode.test.ts).
// Rule: all secrets of a platform present -> signed; none present -> unsigned; anything in between -> throw,
// so a half-configured pipeline fails the job instead of silently shipping unsigned output.
// Error messages name variables, never values.

export class SigningConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SigningConfigError';
  }
}

const WIN_PFX = ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'];
const WIN_AZURE = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'AZURE_SIGN_ENDPOINT',
  'AZURE_SIGN_ACCOUNT',
  'AZURE_SIGN_PROFILE',
  'AZURE_SIGN_PUBLISHER',
];
const MAC_ALL = ['MAC_CSC_LINK', 'MAC_CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];

const present = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';
const missingOf = (env, names) => names.filter((n) => !present(env, n));
const anySet = (env, names) => names.some((n) => present(env, n));

function requireComplete(env, names, label) {
  const missing = missingOf(env, names);
  if (missing.length > 0) {
    throw new SigningConfigError(`${label}: partial signing configuration, missing ${missing.join(', ')}. Set all of ${names.join(', ')} or none of them.`);
  }
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {'win' | 'mac' | 'linux'} platform
 * @returns {{ mode: 'signed' | 'unsigned', method: 'pfx' | 'azure' | 'apple' | 'none' }}
 */
export function describeSigning(env, platform) {
  let result;
  if (platform === 'linux') {
    result = { mode: 'unsigned', method: 'none' };
  } else if (platform === 'win') {
    const pfx = anySet(env, WIN_PFX);
    const azure = anySet(env, WIN_AZURE);
    if (pfx && azure) throw new SigningConfigError('windows: both PFX (WIN_CSC_*) and cloud signing (AZURE_*) variables are set; configure exactly one method.');
    if (pfx) {
      requireComplete(env, WIN_PFX, 'windows PFX');
      result = { mode: 'signed', method: 'pfx' };
    } else if (azure) {
      requireComplete(env, WIN_AZURE, 'windows cloud signing');
      result = { mode: 'signed', method: 'azure' };
    } else {
      result = { mode: 'unsigned', method: 'none' };
    }
  } else if (platform === 'mac') {
    if (anySet(env, MAC_ALL)) {
      requireComplete(env, MAC_ALL, 'macOS signing and notarisation');
      result = { mode: 'signed', method: 'apple' };
    } else {
      result = { mode: 'unsigned', method: 'none' };
    }
  } else {
    throw new SigningConfigError(`unknown platform: ${String(platform)}`);
  }
  if (result.mode === 'unsigned' && platform !== 'linux' && String(env.REQUIRE_SIGNED ?? '').toLowerCase() === 'true') {
    throw new SigningConfigError(`${platform}: REQUIRE_SIGNED=true but no signing secrets are configured.`);
  }
  return result;
}

/** @returns {'signed' | 'unsigned'} */
export function signingMode(env, platform) {
  return describeSigning(env, platform).mode;
}

export const SIGNING_VARIABLES = { win: { pfx: WIN_PFX, azure: WIN_AZURE }, mac: MAC_ALL };
