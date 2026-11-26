// Pure helpers of scripts/publish-downloads.mjs (tested in downloads.test.mjs). No I/O here.

export const REPO = 'menarzullayev/davrabox';

/** Which CI artifact holds which beta package. */
export const SOURCES = {
  android: { workflow: 'android.yml', artifact: 'davrabox-debug-apk', ext: '.apk' },
  windows: { workflow: 'desktop.yml', artifact: 'desktop-Windows-UNSIGNED', ext: '.exe' },
};

/** A run qualifies only when it succeeded on main (a build of reviewed code, never a pull-request branch). */
export function checkRun(run) {
  if (!run || typeof run !== 'object') return 'no run information';
  if (run.conclusion !== 'success') return `run ${run.databaseId} did not succeed (${run.conclusion})`;
  if (run.headBranch !== 'main') return `run ${run.databaseId} is from ${run.headBranch}, not main`;
  if (!/^[0-9a-f]{40}$/.test(run.headSha ?? '')) return `run ${run.databaseId} has no commit`;
  return null;
}

const safe = (s) => String(s).toLowerCase().replace(/[^a-z0-9.+-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';

/** Published file name: davrabox-<platform>-<version>-beta-<commit7><ext>, unique per build so caches never serve an old file. */
export function publishedName(platform, version, headSha) {
  return `davrabox-${platform}-${safe(version)}-beta-${headSha.slice(0, 7)}${SOURCES[platform].ext}`;
}

/** Manifest entry in the shape apps/web/src/landing/downloads.ts accepts. */
export function manifestEntry({ platform, file, size, sha256, version, run }) {
  return {
    platform,
    file,
    url: `/downloads/${file}`,
    size,
    sha256,
    version: `${version}-beta`,
    commit: run.headSha,
    runUrl: `https://github.com/${REPO}/actions/runs/${run.databaseId}`,
    builtAt: run.createdAt,
  };
}

/** sha256sum-compatible list ("<hash>  <file>"). */
export function sha256sums(entries) {
  return entries.map((e) => `${e.sha256}  ${e.file}`).join('\n') + '\n';
}
