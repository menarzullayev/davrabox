// Usage: node scripts/verify-signature.mjs <artifact> [--platform win|mac]
// Exits 0 only when every check passes; 1 when the artifact is unsigned or a check fails; 2 on usage errors
// (including artifact types for which no signature check exists, so they can never pass by accident).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const PLATFORMS = ['win', 'mac'];

export function parseArgs(argv) {
  let file;
  let platform;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--platform') {
      const v = argv[++i];
      if (!v || !PLATFORMS.includes(v)) throw new UsageError(`--platform needs one of: ${PLATFORMS.join(', ')}`);
      platform = v;
    } else if (a.startsWith('--')) {
      throw new UsageError(`unknown option ${a}`);
    } else if (file === undefined) {
      file = a;
    } else {
      throw new UsageError('exactly one artifact path is expected');
    }
  }
  if (file === undefined) throw new UsageError('usage: verify-signature.mjs <artifact> [--platform win|mac]');
  return { file, platform };
}

/** Builds the list of commands that must all succeed for the artifact to count as signed. */
export function planVerification(file, platform) {
  const lower = file.toLowerCase();
  const isWin = /\.(exe|msi|dll)$/.test(lower);
  const isMacBundle = /\.app\/?$/.test(lower);
  const isMacImage = /\.(dmg|pkg)$/.test(lower);
  if (!isWin && !isMacBundle && !isMacImage) throw new UsageError(`no signature check is defined for ${file} (only .exe/.msi/.dll, .app, .dmg, .pkg)`);
  if (isWin) {
    if (platform !== 'win') throw new UsageError('Windows artifacts must be verified on a Windows runner (--platform win)');
    return [{ command: 'signtool', args: ['verify', '/pa', '/all', '/v', file] }];
  }
  if (platform !== 'mac') throw new UsageError('macOS artifacts must be verified on a macOS runner (--platform mac)');
  const spctlType = isMacBundle ? ['--type', 'execute'] : ['--type', 'open', '--context', 'context:primary-signature'];
  return [
    { command: 'codesign', args: ['--verify', '--deep', '--strict', '--verbose=2', file] },
    { command: 'spctl', args: ['--assess', ...spctlType, '-vv', file] },
    // Notarisation ticket: a signed but not notarised app is still rejected by Gatekeeper on other machines.
    { command: 'xcrun', args: ['stapler', 'validate', file] },
  ];
}

function hostPlatform() {
  return process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : undefined;
}

function main(argv) {
  let parsed;
  let plan;
  try {
    parsed = parseArgs(argv);
    const platform = parsed.platform ?? hostPlatform();
    if (!existsSync(parsed.file)) throw new UsageError(`artifact not found: ${parsed.file}`);
    plan = planVerification(parsed.file, platform);
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    return 2;
  }
  for (const step of plan) {
    console.log(`> ${step.command} ${step.args.join(' ')}`);
    const r = spawnSync(step.command, step.args, { stdio: 'inherit', shell: false });
    if (r.error) {
      console.error(`UNSIGNED/UNVERIFIED: could not run ${step.command}: ${r.error.message}`);
      return 1;
    }
    if (r.status !== 0) {
      console.error(`UNSIGNED/UNVERIFIED: ${step.command} exited with ${r.status}`);
      return 1;
    }
  }
  console.log(`SIGNED: ${parsed.file}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
