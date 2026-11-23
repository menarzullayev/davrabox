// Release build driver: decides signed vs unsigned from the environment (see signing-mode.mjs), builds, and records the result.
// Usage: node scripts/dist.mjs [--dir]
//   --dir      unpacked build only (used locally and for the fuse check)

import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describeSigning, SigningConfigError } from './signing-mode.mjs';

const argv = process.argv.slice(2);
const dirOnly = argv.includes('--dir');
for (const a of argv) if (!['--dir'].includes(a)) throw new Error(`unknown option ${a}`);

const platform = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : 'linux';
const flag = { win: '--win', mac: '--mac', linux: '--linux' }[platform];

function summary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

let decision;
try {
  decision = describeSigning(process.env, platform);
} catch (e) {
  if (e instanceof SigningConfigError) {
    summary(`### Desktop ${platform}: FAILED\n${e.message}`);
    process.exit(1);
  }
  throw e;
}

// Build a clean environment so an unrelated certificate on the machine is never picked up by accident.
const env = { ...process.env };
for (const k of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete env[k];
const overrides = [];

if (decision.mode === 'signed') {
  overrides.push('-c.forceCodeSigning=true');
  if (decision.method === 'pfx') {
    env.WIN_CSC_LINK = process.env.WIN_CSC_LINK;
    env.WIN_CSC_KEY_PASSWORD = process.env.WIN_CSC_KEY_PASSWORD;
  } else if (decision.method === 'azure') {
    overrides.push(
      `-c.win.azureSignOptions.endpoint=${process.env.AZURE_SIGN_ENDPOINT}`,
      `-c.win.azureSignOptions.codeSigningAccountName=${process.env.AZURE_SIGN_ACCOUNT}`,
      `-c.win.azureSignOptions.certificateProfileName=${process.env.AZURE_SIGN_PROFILE}`,
      `-c.win.azureSignOptions.publisherName=${process.env.AZURE_SIGN_PUBLISHER}`,
    );
  } else if (decision.method === 'apple') {
    env.CSC_LINK = process.env.MAC_CSC_LINK;
    env.CSC_KEY_PASSWORD = process.env.MAC_CSC_KEY_PASSWORD;
  }
} else {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  overrides.push('-c.artifactName=${productName}-${version}-UNSIGNED-${arch}.${ext}');
  if (platform === 'mac') overrides.push('-c.mac.notarize=false');
}

mkdirSync('dist', { recursive: true });
writeFileSync('dist/build-info.json', `${JSON.stringify({ signed: decision.mode === 'signed', platform })}\n`);

const require = createRequire(import.meta.url);
const cli = require.resolve('electron-builder/cli.js');
const args = [cli, flag, ...(dirOnly ? ['--dir'] : []), '--publish', 'never', ...overrides];
const r = spawnSync(process.execPath, args, { stdio: 'inherit', env });
if (r.status !== 0) {
  summary(`### Desktop ${platform}: FAILED\nelectron-builder exited with ${r.status ?? 'a signal'}.`);
  process.exit(r.status ?? 1);
}
summary(
  decision.mode === 'signed'
    ? `### Desktop ${platform}: SIGNED (${decision.method}${platform === 'mac' ? ', notarised' : ''})`
    : `### Desktop ${platform}: UNSIGNED - test build only, the artifact name carries "UNSIGNED"; it must not be distributed${platform === 'linux' ? ' (Linux has no code signing; this is expected)' : ''}`,
);
