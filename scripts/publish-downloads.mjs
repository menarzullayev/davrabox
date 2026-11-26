#!/usr/bin/env node
// Publishes the beta app packages (owner decision 4 of 2026-11-26): takes the Android APK and the Windows installer from
// successful GitHub Actions runs on main, computes SHA-256, writes manifest.json + SHA256SUMS, and (with --upload) copies
// them to the production server's deploy/prod/downloads folder, which Caddy serves at /downloads/.
//
//   node scripts/publish-downloads.mjs [--android-run <id>] [--windows-run <id>] [--out <dir>] [--upload <ssh-target>:<dir>] [--ssh-key <file>] [--server-fetch]
//
// Without a run id the newest successful run on main of the workflow is used. Needs `gh` (signed in) and, for --upload,
// `ssh`/`scp`. Server addresses are never written into the repository: pass them on the command line.
//
// --server-fetch (with --upload): the server downloads the packages itself from the same CI artifacts instead of this
// machine copying them over a slow uplink. This machine still downloads and hashes every package; the server gets a
// short-lived signed artifact URL on stdin (the GitHub token never leaves this machine) and keeps a package only when
// its SHA-256 matches. Only SHA256SUMS and manifest.json are copied from here.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRun, manifestEntry, parseUploadTarget, pickArtifact, publishedName, REPO, SOURCES, serverFetchScript, sha256sums } from './lib/downloads.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

function pickRun(platform, explicit) {
  const { workflow } = SOURCES[platform];
  const fields = 'databaseId,conclusion,headBranch,headSha,createdAt,url';
  const run = explicit
    ? JSON.parse(gh(['run', 'view', explicit, '-R', REPO, '--json', fields]))
    : JSON.parse(gh(['run', 'list', '-R', REPO, '--workflow', workflow, '--branch', 'main', '--status', 'success', '--limit', '1', '--json', fields]))[0];
  const problem = checkRun(run);
  if (problem) throw new Error(`${platform}: ${problem}`);
  return run;
}

function findFile(dir, ext) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.toLowerCase().endsWith(ext) && !n.toLowerCase().includes('uninstall')) out.push(p);
    }
  };
  walk(dir);
  if (out.length !== 1) throw new Error(`expected exactly one ${ext} in the artifact, found ${out.length}`);
  return out[0];
}

function versionOf(platform) {
  // The Android versionName and the desktop package version both default to the desktop package.json version.
  const pkg = JSON.parse(readFileSync(new URL('../apps/desktop/package.json', import.meta.url), 'utf8'));
  return platform === 'android' ? process.env.ANDROID_VERSION_NAME || pkg.version : pkg.version;
}

/** The artifact's short-lived signed download URL: GitHub answers the zip endpoint with a redirect to blob storage. */
async function signedArtifactUrl(artifactId) {
  const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/artifacts/${artifactId}/zip`, {
    redirect: 'manual',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  const url = res.headers.get('location');
  if (res.status < 300 || res.status >= 400 || !url?.startsWith('https://')) throw new Error(`artifact ${artifactId}: no download redirect (HTTP ${res.status})`);
  return url;
}

const upload = arg('upload');
const serverFetch = process.argv.includes('--server-fetch');
if (serverFetch && !upload) throw new Error('--server-fetch needs --upload <user>@<host>:<dir>');
const remote = upload ? parseUploadTarget(upload) : null;

const out = arg('out') ?? mkdtempSync(join(tmpdir(), 'davra-downloads-'));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'davra-artifacts-'));
const entries = [];
try {
  for (const platform of /** @type {const} */ (['android', 'windows'])) {
    const run = pickRun(platform, arg(`${platform}-run`));
    const picked = pickArtifact(JSON.parse(gh(['api', `repos/${REPO}/actions/runs/${run.databaseId}/artifacts`])), SOURCES[platform].artifact);
    if (picked.error) throw new Error(`${platform}: run ${run.databaseId}: ${picked.error}`);
    const dir = join(work, platform);
    gh(['run', 'download', String(run.databaseId), '-R', REPO, '-n', SOURCES[platform].artifact, '-D', dir]);
    const src = findFile(dir, SOURCES[platform].ext);
    const version = versionOf(platform);
    const file = publishedName(platform, version, run.headSha);
    copyFileSync(src, join(out, file));
    const buf = readFileSync(join(out, file));
    const entry = manifestEntry({ platform, file, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), version, run });
    entries.push({ ...entry, artifactId: picked.artifact.id });
    console.log(`${platform}: ${file} ${(buf.length / 1048576).toFixed(1)} MB sha256 ${entry.sha256} (run ${run.databaseId}, ${run.headSha.slice(0, 7)})`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
// artifactId is only for --server-fetch; the published manifest keeps the shape the landing page reads.
const items = entries.map(({ artifactId, ...entry }) => entry);
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), items }, null, 2) + '\n');
writeFileSync(join(out, 'SHA256SUMS'), sha256sums(entries));
console.log(`written to ${out}`);

if (remote) {
  const { target, dest } = remote;
  const key = arg('ssh-key');
  const sshArgs = key ? ['-i', key] : [];
  const ssh = (cmd, input) => execFileSync('ssh', [...sshArgs, target, cmd], { stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'], input });
  ssh(`mkdir -p ${dest}`);
  // Packages first, the manifest last: the page never points at a file that is not there yet.
  for (const e of entries) {
    if (serverFetch) ssh(serverFetchScript({ dest, file: e.file, ext: SOURCES[e.platform].ext, sha256: e.sha256 }), `${await signedArtifactUrl(e.artifactId)}\n`);
    else execFileSync('scp', [...sshArgs, '-q', join(out, e.file), `${target}:${dest}/${e.file}`], { stdio: 'inherit' });
  }
  for (const f of ['SHA256SUMS', 'manifest.json']) execFileSync('scp', [...sshArgs, '-q', join(out, f), `${target}:${dest}/${f}.part`], { stdio: 'inherit' });
  // Every package must match SHA256SUMS on the server before the new manifest goes live.
  ssh(`cd ${dest} && sha256sum -c SHA256SUMS.part && mv -f SHA256SUMS.part SHA256SUMS && mv -f manifest.json.part manifest.json`);
  // Older packages are removed only after the new manifest is in place.
  const keep = entries.map((e) => e.file).join('|');
  ssh(`cd ${dest} && for f in *.apk *.exe; do [ -e "$f" ] || continue; case "$f" in ${keep}) ;; *) rm -f -- "$f";; esac; done; chmod 644 ${dest}/*; ls -l ${dest}`);
}
