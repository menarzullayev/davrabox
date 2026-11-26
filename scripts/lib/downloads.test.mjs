import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRun, manifestEntry, parseUploadTarget, pickArtifact, publishedName, serverFetchScript, sha256sums } from './downloads.mjs';

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

  it('picks the one live artifact of a run by name', () => {
    const list = { artifacts: [{ id: 1, name: 'davrabox-debug-apk', expired: true }, { id: 2, name: 'davrabox-debug-apk', expired: false }, { id: 3, name: 'other', expired: false }] };
    expect(pickArtifact(list, 'davrabox-debug-apk')).toEqual({ artifact: { id: 2, name: 'davrabox-debug-apk', expired: false } });
    expect(pickArtifact({ artifacts: [] }, 'davrabox-debug-apk').error).toMatch(/found 0/);
    expect(pickArtifact(null, 'x').error).toMatch(/found 0/);
  });

  it('parses --upload and rejects paths unsafe for a remote shell', () => {
    expect(parseUploadTarget('ubuntu@example.test:/opt/davrabox/repo/deploy/prod/downloads')).toEqual({ target: 'ubuntu@example.test', dest: '/opt/davrabox/repo/deploy/prod/downloads' });
    expect(() => parseUploadTarget('/no/host')).toThrow(/must look like/);
    expect(() => parseUploadTarget('u@h:/x;rm -rf ~')).toThrow(/only/);
    expect(() => parseUploadTarget('-oProxyCommand=x:/d')).toThrow(/must not start/);
  });

  const good = { dest: '/opt/d/downloads', file: 'davrabox-android-0.1.0-beta-e5ac17d.apk', ext: '.apk', sha256: 'a'.repeat(64) };

  it('builds a server script that never carries the URL and checks the hash before the file goes live', () => {
    const sh = serverFetchScript(good);
    expect(sh).toContain('IFS= read -r url');
    expect(sh).not.toMatch(/https?:\/\//);
    expect(sh.indexOf('sha256sum')).toBeLessThan(sh.indexOf('mv -f'));
    expect(() => serverFetchScript({ ...good, dest: '/x; reboot' })).toThrow(/unsafe/);
    expect(() => serverFetchScript({ ...good, file: '../../etc/passwd' })).toThrow(/unexpected package/);
    expect(() => serverFetchScript({ ...good, ext: '.sh' })).toThrow(/extension/);
    expect(() => serverFetchScript({ ...good, sha256: 'zz' })).toThrow(/64 hex/);
  });

  // Runs the generated script with sh, python3 and a file:// URL, like the server does with the signed URL.
  const tools = (() => {
    try {
      execFileSync('sh', ['-c', 'command -v python3 && command -v curl && command -v sha256sum'], { stdio: 'ignore' });
      execFileSync('python3', ['-c', 'import zipfile'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(!tools || process.platform === 'win32')('server script: keeps a matching package, refuses a tampered one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'davra-fetch-test-'));
    try {
      const payload = 'fake apk bytes';
      writeFileSync(join(dir, 'app-debug.apk'), payload);
      execFileSync('python3', ['-c', `import zipfile; z=zipfile.ZipFile('${dir}/a.zip','w'); z.write('${dir}/app-debug.apk','app-debug.apk'); z.close()`]);
      const sha = execFileSync('sh', ['-c', `printf %s '${payload}' | sha256sum | cut -d' ' -f1`], { encoding: 'utf8' }).trim();
      const dest = join(dir, 'out');
      const run = (sha256) => execFileSync('sh', ['-c', serverFetchScript({ ...good, dest, sha256 })], { input: `file://${dir}/a.zip\n`, stdio: ['pipe', 'pipe', 'pipe'] });
      run(sha);
      expect(readFileSync(join(dest, good.file), 'utf8')).toBe(payload);
      rmSync(join(dest, good.file));
      expect(() => run('b'.repeat(64))).toThrow();
      expect(existsSync(join(dest, good.file))).toBe(false);
      expect(existsSync(join(dest, `${good.file}.part`))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
