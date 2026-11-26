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

/** The live (not expired) artifact of a run with the given name, from `GET /actions/runs/<id>/artifacts`. */
export function pickArtifact(list, name) {
  const found = (list?.artifacts ?? []).filter((a) => a.name === name && !a.expired);
  if (found.length !== 1) return { error: `expected one live artifact "${name}", found ${found.length}` };
  return { artifact: found[0] };
}

/** `user@host:/abs/path` of --upload, with a path that is safe to put into a remote shell command. */
export function parseUploadTarget(upload) {
  const sep = String(upload ?? '').lastIndexOf(':');
  if (sep <= 0) throw new Error('--upload must look like user@host:/path/to/deploy/prod/downloads');
  const target = upload.slice(0, sep);
  const dest = upload.slice(sep + 1);
  if (!/^[\w./-]+$/.test(dest)) throw new Error('--upload path: letters, digits, ".", "_", "-" and "/" only');
  if (target.startsWith('-')) throw new Error('--upload target must not start with "-"');
  return { target, dest };
}

const FILE_RE = /^davrabox-[a-z]+-[a-z0-9.+-]+-beta-[0-9a-f]{7}\.(apk|exe)$/;

/**
 * POSIX sh run on the server for --server-fetch: reads the short-lived signed artifact URL from stdin (it never
 * appears on a command line or in a log), downloads the artifact zip, extracts the one package, and moves it into
 * place only when its SHA-256 equals the hash of the copy this machine downloaded itself.
 */
export function serverFetchScript({ dest, file, ext, sha256 }) {
  if (!/^[\w./-]+$/.test(dest)) throw new Error(`unsafe destination: ${dest}`);
  if (!FILE_RE.test(file)) throw new Error(`unexpected package name: ${file}`);
  if (ext !== '.apk' && ext !== '.exe') throw new Error(`unexpected extension: ${ext}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('sha256 must be 64 hex characters');
  const extract = [
    'import sys, zipfile, shutil',
    'z = zipfile.ZipFile(sys.argv[1])',
    "names = [n for n in z.namelist() if n.lower().endswith(sys.argv[2]) and 'uninstall' not in n.lower()]",
    "if len(names) != 1: sys.exit('expected exactly one package in the artifact, found %d' % len(names))",
    "with z.open(names[0]) as s, open(sys.argv[3], 'wb') as d: shutil.copyfileobj(s, d)",
  ].join('\n');
  return [
    'set -eu',
    'IFS= read -r url',
    `mkdir -p ${dest}`,
    'tmp=$(mktemp -d)',
    `trap 'rm -rf "$tmp" ${dest}/${file}.part' EXIT`,
    'curl -sfL --retry 3 --max-time 1800 -o "$tmp/artifact.zip" "$url"',
    `python3 - "$tmp/artifact.zip" ${ext} ${dest}/${file}.part <<'PY'`,
    extract,
    'PY',
    `got=$(sha256sum ${dest}/${file}.part | cut -d' ' -f1)`,
    `if [ "$got" != ${sha256} ]; then echo "${file}: SHA-256 mismatch ($got)" >&2; exit 1; fi`,
    `chmod 644 ${dest}/${file}.part`,
    `mv -f ${dest}/${file}.part ${dest}/${file}`,
    `echo "${file}: fetched by the server, SHA-256 OK"`,
  ].join('\n');
}
