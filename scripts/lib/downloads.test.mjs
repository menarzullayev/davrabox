import { describe, expect, it } from 'vitest';
import { checkRun, manifestEntry, publishedName, sha256sums } from './downloads.mjs';

const run = { databaseId: 45838432442, conclusion: 'success', headBranch: 'main', headSha: 'e5ac17d0'.padEnd(40, '0'), createdAt: '2026-11-26T14:22:56Z' };

describe('publish-downloads helpers', () => {
  it('accepts only successful runs on main', () => {
    expect(checkRun(run)).toBeNull();
    expect(checkRun({ ...run, conclusion: 'failure' })).toMatch(/did not succeed/);
    expect(checkRun({ ...run, headBranch: 'feat/x' })).toMatch(/not main/);
    expect(checkRun({ ...run, headSha: '' })).toMatch(/no commit/);
    expect(checkRun(null)).toMatch(/no run/);
  });

  it('names files per platform, version and commit, safe for a URL', () => {
    expect(publishedName('android', '0.1.0', run.headSha)).toBe('davrabox-android-0.1.0-beta-e5ac17d.apk');
    expect(publishedName('windows', '0.1.0 RC/1', run.headSha)).toBe('davrabox-windows-0.1.0-rc-1-beta-e5ac17d.exe');
  });

  it('builds the manifest entry the landing page accepts, tied to the CI run', () => {
    const e = manifestEntry({ platform: 'android', file: 'davrabox-android-0.1.0-beta-e5ac17d.apk', size: 10, sha256: 'a'.repeat(64), version: '0.1.0', run });
    expect(e).toEqual({
      platform: 'android',
      file: 'davrabox-android-0.1.0-beta-e5ac17d.apk',
      url: '/downloads/davrabox-android-0.1.0-beta-e5ac17d.apk',
      size: 10,
      sha256: 'a'.repeat(64),
      version: '0.1.0-beta',
      commit: run.headSha,
      runUrl: 'https://github.com/menarzullayev/davrabox/actions/runs/45838432442',
      builtAt: '2026-11-26T14:22:56Z',
    });
    expect(sha256sums([e])).toBe(`${'a'.repeat(64)}  davrabox-android-0.1.0-beta-e5ac17d.apk\n`);
  });
});
