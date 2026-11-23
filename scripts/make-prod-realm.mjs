// Writes deploy/keycloak/davrabox-realm.prod.json from the development realm and refuses to write a weak one.
// Usage: node scripts/make-prod-realm.mjs [--check]   (--check is run by CI so the checked-in file never drifts)
import { readFileSync, writeFileSync } from 'node:fs';
import { auditProdRealm, toProdRealm } from './lib/prod-realm.mjs';

const src = new URL('../deploy/keycloak/davrabox-realm.json', import.meta.url);
const dst = new URL('../deploy/keycloak/davrabox-realm.prod.json', import.meta.url);
const prod = toProdRealm(JSON.parse(readFileSync(src, 'utf8')));
const problems = auditProdRealm(prod);
if (problems.length) {
  console.error('production realm rejected:\n- ' + problems.join('\n- '));
  process.exit(1);
}
const text = JSON.stringify(prod, null, 2) + '\n';
if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(dst, 'utf8');
  } catch {
    /* missing */
  }
  if (current !== text) {
    console.error('davrabox-realm.prod.json is out of date: run node scripts/make-prod-realm.mjs');
    process.exit(1);
  }
  console.log('production realm is up to date');
} else {
  writeFileSync(dst, text);
  console.log('wrote deploy/keycloak/davrabox-realm.prod.json');
}
