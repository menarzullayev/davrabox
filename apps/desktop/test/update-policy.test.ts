import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { UPDATE_FEED, hasPublisherName, parseBuildInfo, updatesEnabled } from '../src/update-policy';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

describe('parseBuildInfo (fails closed)', () => {
  it('is signed only for an explicit boolean true', () => {
    expect(parseBuildInfo('{"signed":true}').signed).toBe(true);
    for (const raw of ['{"signed":"true"}', '{"signed":1}', '{}', '[]', 'null', 'not json', '', undefined]) {
      expect(parseBuildInfo(raw).signed).toBe(false);
    }
  });
});

describe('hasPublisherName', () => {
  it('needs a non-empty publisherName entry in app-update.yml', () => {
    expect(hasPublisherName('provider: github\npublisherName:\n  - CN=DavraBox\n')).toBe(true);
    expect(hasPublisherName('provider: github\npublisherName: DavraBox LLC\n')).toBe(true);
    expect(hasPublisherName('provider: github\nowner: x\n')).toBe(false);
    expect(hasPublisherName('provider: github\npublisherName:\nowner: x\n')).toBe(false);
    expect(hasPublisherName(undefined)).toBe(false);
  });
});

describe('updatesEnabled', () => {
  const base = { packaged: true, signed: true, platform: 'win32' as NodeJS.Platform, updateYml: 'publisherName:\n  - CN=X\n', env: {} };
  it('is on only for a packaged, signed build', () => {
    expect(updatesEnabled(base)).toBe(true);
    expect(updatesEnabled({ ...base, packaged: false })).toBe(false);
    expect(updatesEnabled({ ...base, signed: false })).toBe(false);
  });
  it('can be switched off by the operator', () => {
    expect(updatesEnabled({ ...base, env: { DAVRABOX_DISABLE_UPDATES: '1' } })).toBe(false);
  });
  it('ignores any environment attempt to switch it on or to change the feed', () => {
    expect(updatesEnabled({ ...base, signed: false, env: { DAVRABOX_ENABLE_UPDATES: '1', ELECTRON_UPDATER_FEED: 'https://evil.example' } })).toBe(false);
  });
  it('on Windows requires publisherName so the signature of the update is really checked', () => {
    expect(updatesEnabled({ ...base, updateYml: 'provider: github\n' })).toBe(false);
    expect(updatesEnabled({ ...base, platform: 'darwin', updateYml: 'provider: github\n' })).toBe(true);
  });
  it('is never on for Linux (no signing exists there)', () => {
    expect(updatesEnabled({ ...base, platform: 'linux' })).toBe(false);
  });
});

describe('update channel configuration', () => {
  it('the fixed feed in code equals the publish config the builder writes', () => {
    expect(pkg.build.publish).toEqual({ provider: 'github', owner: UPDATE_FEED.owner, repo: UPDATE_FEED.repo, releaseType: 'release' });
  });
  it('the builder verifies update signatures on Windows and never downgrades via a custom feed', () => {
    expect(pkg.build.win.verifyUpdateCodeSignature).toBe(true);
    expect(JSON.stringify(pkg.build)).not.toMatch(/"provider":\s*"generic"/);
  });
  it('macOS ships dmg and zip (zip is required by the macOS updater) with hardened runtime and notarisation on', () => {
    expect(pkg.build.mac.target).toEqual(expect.arrayContaining(['dmg', 'zip']));
    expect(pkg.build.mac.hardenedRuntime).toBe(true);
    expect(pkg.build.mac.notarize).toBe(true);
    expect(pkg.build.mac.entitlements).toBe('build/entitlements.mac.plist');
    expect(pkg.build.mac.entitlementsInherit).toBe('build/entitlements.mac.plist');
  });
});
