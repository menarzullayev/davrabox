// Writes public/.well-known/assetlinks.json from ANDROID_SHA256_CERT_FINGERPRINT (see assetlinks-lib.mjs).
// Runs before the web build; removes a stale file when the variable is not set.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAssetLinks } from './assetlinks-lib.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', '.well-known');
const file = join(dir, 'assetlinks.json');
const doc = buildAssetLinks(process.env.ANDROID_SHA256_CERT_FINGERPRINT);
if (doc === null) {
  rmSync(file, { force: true });
  console.log('assetlinks.json not written (ANDROID_SHA256_CERT_FINGERPRINT not set)');
} else {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`assetlinks.json written (${doc[0].target.sha256_cert_fingerprints.length} fingerprint(s))`);
}
