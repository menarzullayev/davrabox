#!/usr/bin/env node
// Publishes the beta app packages (owner decision 4 of 2026-11-26): takes the Android APK and the Windows installer from
// successful GitHub Actions runs on main, computes SHA-256, writes manifest.json + SHA256SUMS, and (with --upload) copies
// them to the production server's deploy/prod/downloads folder, which Caddy serves at /downloads/.
//
//   node scripts/publish-downloads.mjs [--android-run <id>] [--windows-run <id>] [--out <dir>] [--upload <ssh-target>:<dir>] [--ssh-key <file>]
//
// Without a run id the newest successful run on main of the workflow is used. Needs `gh` (signed in) and, for --upload,
// `ssh`/`scp`. Server addresses are never written into the repository: pass them on the command line.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRun, manifestEntry, publishedName, REPO, SOURCES, sha256sums } from './lib/downloads.mjs';

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

const out = arg('out') ?? mkdtempSync(join(tmpdir(), 'davra-downloads-'));
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'davra-artifacts-'));
const entries = [];
try {
  for (const platform of /** @type {const} */ (['android', 'windows'])) {
    const run = pickRun(platform, arg(`${platform}-run`));
    const dir = join(work, platform);
    gh(['run', 'download', String(run.databaseId), '-R', REPO, '-n', SOURCES[platform].artifact, '-D', dir]);
    const src = findFile(dir, SOURCES[platform].ext);
    const version = versionOf(platform);
    const file = publishedName(platform, version, run.headSha);
    copyFileSync(src, join(out, file));
    const buf = readFileSync(join(out, file));
    const entry = manifestEntry({ platform, file, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), version, run });
    entries.push(entry);
    console.log(`${platform}: ${file} ${(buf.length / 1048576).toFixed(1)} MB sha256 ${entry.sha256} (run ${run.databaseId}, ${run.headSha.slice(0, 7)})`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), items: entries }, null, 2) + '\n');
writeFileSync(join(out, 'SHA256SUMS'), sha256sums(entries));
console.log(`written to ${out}`);

const upload = arg('upload');
if (upload) {
  const sep = upload.lastIndexOf(':');
  if (sep <= 0) throw new Error('--upload must look like user@host:/path/to/deploy/prod/downloads');
  const target = upload.slice(0, sep);
  const dest = upload.slice(sep + 1);
  if (!/^[\w./-]+$/.test(dest)) throw new Error('--upload path: letters, digits, ".", "_", "-" and "/" only');
  const key = arg('ssh-key');
  const sshArgs = key ? ['-i', key] : [];
  const files = [...entries.map((e) => e.file), 'SHA256SUMS', 'manifest.json'];
  execFileSync('ssh', [...sshArgs, target, `mkdir -p ${dest}`], { stdio: 'inherit' });
  // Packages first, the manifest last: the page never points at a file that is not there yet.
  for (const f of files) execFileSync('scp', [...sshArgs, '-q', join(out, f), `${target}:${dest}/${f}`], { stdio: 'inherit' });
  // Older packages are removed only after the new manifest is in place.
  const keep = entries.map((e) => e.file).join('|');
  execFileSync('ssh', [...sshArgs, target, `cd ${dest} && for f in *.apk *.exe; do [ -e "$f" ] || continue; case "$f" in ${keep}) ;; *) rm -f -- "$f";; esac; done; chmod 644 ${dest}/*; ls -l ${dest}`], { stdio: 'inherit' });
}
