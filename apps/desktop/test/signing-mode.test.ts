import { describe, expect, it } from 'vitest';
import { SigningConfigError, describeSigning, signingMode } from '../scripts/signing-mode.mjs';

const PFX = { WIN_CSC_LINK: 'base64-pfx', WIN_CSC_KEY_PASSWORD: 'pw' };
const AZURE = {
  AZURE_TENANT_ID: 't',
  AZURE_CLIENT_ID: 'c',
  AZURE_CLIENT_SECRET: 's',
  AZURE_SIGN_ENDPOINT: 'https://eus.codesigning.azure.net',
  AZURE_SIGN_ACCOUNT: 'acct',
  AZURE_SIGN_PROFILE: 'profile',
  AZURE_SIGN_PUBLISHER: 'CN=DavraBox',
};
const MAC = { MAC_CSC_LINK: 'base64-p12', MAC_CSC_KEY_PASSWORD: 'pw', APPLE_ID: 'a@example.com', APPLE_APP_SPECIFIC_PASSWORD: 'x', APPLE_TEAM_ID: 'ABCDE12345' };

describe('signingMode: Windows', () => {
  it('is unsigned when no secret is present (empty strings count as absent)', () => {
    expect(signingMode({}, 'win')).toBe('unsigned');
    expect(signingMode({ WIN_CSC_LINK: '', WIN_CSC_KEY_PASSWORD: '  ' }, 'win')).toBe('unsigned');
  });
  it('is signed with a complete PFX set', () => {
    expect(signingMode(PFX, 'win')).toBe('signed');
    expect(describeSigning(PFX, 'win').method).toBe('pfx');
  });
  it('is signed with a complete cloud signing set', () => {
    expect(signingMode(AZURE, 'win')).toBe('signed');
    expect(describeSigning(AZURE, 'win').method).toBe('azure');
  });
  it('fails on a partial PFX set and names the missing variable but never a value', () => {
    expect(() => signingMode({ WIN_CSC_LINK: 'secret-value' }, 'win')).toThrow(SigningConfigError);
    try {
      signingMode({ WIN_CSC_LINK: 'secret-value' }, 'win');
    } catch (e) {
      expect(String((e as Error).message)).toContain('WIN_CSC_KEY_PASSWORD');
      expect(String((e as Error).message)).not.toContain('secret-value');
    }
  });
  it('fails on a partial cloud set', () => {
    const { AZURE_CLIENT_SECRET: _omit, ...partial } = AZURE;
    expect(() => signingMode(partial, 'win')).toThrow(/AZURE_CLIENT_SECRET/);
  });
  it('fails when both methods are configured (ambiguous)', () => {
    expect(() => signingMode({ ...PFX, ...AZURE }, 'win')).toThrow(/both/i);
  });
  it('ignores macOS secrets on a Windows job', () => {
    expect(signingMode(MAC, 'win')).toBe('unsigned');
  });
});

describe('signingMode: macOS', () => {
  it('is unsigned with nothing set and signed with all five', () => {
    expect(signingMode({}, 'mac')).toBe('unsigned');
    expect(signingMode(MAC, 'mac')).toBe('signed');
  });
  it.each(Object.keys(MAC))('fails when only %s is missing', (missing) => {
    const env: Record<string, string> = { ...MAC };
    delete env[missing];
    expect(() => signingMode(env, 'mac')).toThrow(new RegExp(missing));
  });
  it('fails when only the certificate is present (no notarisation credentials)', () => {
    expect(() => signingMode({ MAC_CSC_LINK: 'x', MAC_CSC_KEY_PASSWORD: 'y' }, 'mac')).toThrow(/APPLE_TEAM_ID/);
  });
  it('fails when only notarisation credentials are present (no certificate)', () => {
    expect(() => signingMode({ APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }, 'mac')).toThrow(/MAC_CSC_LINK/);
  });
});

describe('signingMode: other', () => {
  it('Linux is always unsigned (no code signing there)', () => {
    expect(signingMode(MAC, 'linux')).toBe('unsigned');
  });
  it('rejects an unknown platform', () => {
    expect(() => signingMode({}, 'plan9' as never)).toThrow(SigningConfigError);
  });
  it('REQUIRE_SIGNED=true turns "unsigned" into a failure', () => {
    expect(() => signingMode({ REQUIRE_SIGNED: 'true' }, 'win')).toThrow(/REQUIRE_SIGNED/);
    expect(signingMode({ REQUIRE_SIGNED: 'true', ...PFX }, 'win')).toBe('signed');
    expect(signingMode({ REQUIRE_SIGNED: 'true' }, 'linux')).toBe('unsigned');
  });
});
