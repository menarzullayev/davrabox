// End-to-end: self-serve trial sign-up in a real browser against the real stack (Caddy, Vite or nginx, API, Keycloak, Postgres).
// A new visitor opens the landing page, starts the free trial, solves the proof of work, is sent to the sign-in page with the
// email prefilled, signs in, lands in /app as the administrator of a brand-new organization and creates a meeting. A second
// sign-up with the same email shows the friendly "already registered" message. Cleanup removes the Keycloak user and the organization.
// Needs the dev stack (`. scripts/devenv.sh`) with KEYCLOAK_ADMIN_URL / client secret set for the API, and docker for the DB cleanup.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { BASE, KC, adminHeaders } from './kc.mjs';

const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};

const tag = randomBytes(4).toString('hex');
const email = `e2e.signup.${tag}@signup-e2e.example.org`;
const password = `Pw-${randomBytes(9).toString('base64url')}-x`;
const orgName = `E2E Signup ${tag}`;

const browser = await chromium.launch({ channel: 'msedge' });
let slug = null;
let exit = 0;
try {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' });
  await ctx.addInitScript(() => localStorage.setItem('skipPreJoin', '1'));
  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await page.waitForSelector('h1', { timeout: 15000 }); // the landing is a lazy chunk
  check('the landing page is served at /', (await page.locator('h1').count()) === 1);
  await page.getByRole('link', { name: 'Start free' }).first().click();
  await page.waitForURL(/\/app\/signup$/);

  check('the slimmed form has no "saved my password" checkbox (decision 3)', (await page.getByRole('checkbox').count()) === 0);
  check('the value panel lists the trial features (decision 6)', /7 days free/.test(await page.getByTestId('su-value').innerText()));
  await page.getByTestId('su-org').fill(orgName);
  await page.getByTestId('su-name').fill('E2E Person');
  await page.getByTestId('su-email').fill(email);
  await page.getByTestId('su-password').fill(password);
  await page.getByRole('button', { name: 'Create organisation' }).click();
  await page.waitForSelector('#username', { timeout: 60000 });
  check('after the proof of work the visitor is sent to the sign-in page with the email prefilled', (await page.inputValue('#username')) === email);

  await page.fill('#password', password);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  check('the new account lands in /app', new URL(page.url()).pathname === '/app');
  check('the new account is the administrator of its organization', (await page.getByTestId('admin-link').count()) === 1);

  const h = await adminHeaders();
  const users = await (await fetch(`${KC}/admin/realms/davrabox/users?email=${encodeURIComponent(email)}&exact=true`, { headers: h })).json();
  slug = users[0]?.attributes?.org_slug?.[0] ?? null;
  check('the user carries the slug of a new organization (not demo)', !!slug && slug !== 'demo', String(slug));

  const title = `Trial meeting ${tag}`;
  await page.getByTestId('new-meeting').click();
  await page.fill('[data-testid=meeting-title]', title);
  await page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await page.waitForSelector(`li:has-text("${title}")`, { timeout: 15000 });
  check('the trial organization can create a meeting', true);

  const again = await (await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' })).newPage();
  await again.goto(BASE + '/app/signup');
  await again.getByTestId('su-org').fill(`${orgName} again`);
  await again.getByTestId('su-name').fill('E2E Person');
  await again.getByTestId('su-email').fill(email.toUpperCase().replace('@SIGNUP-E2E.EXAMPLE.ORG', '@signup-e2e.example.org'));
  await again.getByTestId('su-password').fill(password);
  await again.getByRole('button', { name: 'Create organisation' }).click();
  await again.getByRole('alert').waitFor({ timeout: 60000 });
  check('a second sign-up with the same email shows the "already registered" message', /already registered/i.test(await again.getByRole('alert').innerText()));
} catch (e) {
  console.log('FAILED  unexpected error ::', e instanceof Error ? e.message : String(e));
  exit = 1;
} finally {
  // Cleanup: the Keycloak user, then the organization (cascade removes users, meetings and audit rows).
  try {
    const h = await adminHeaders();
    const users = await (await fetch(`${KC}/admin/realms/davrabox/users?email=${encodeURIComponent(email)}&exact=true`, { headers: h })).json();
    for (const u of users) await fetch(`${KC}/admin/realms/davrabox/users/${u.id}`, { method: 'DELETE', headers: h });
  } catch (e) {
    console.log('cleanup (Keycloak) failed:', e instanceof Error ? e.message : String(e));
  }
  if (slug && /^[a-z0-9-]+$/.test(slug)) {
    const r = spawnSync('docker', ['exec', 'davra-postgres', 'psql', '-U', 'davra_admin', '-d', 'davra', '-v', 'ON_ERROR_STOP=1', '-c', `DELETE FROM organizations WHERE slug = '${slug}'`], { encoding: 'utf8' });
    if (r.status !== 0) console.log('cleanup (organization) failed; remove it by hand:', slug);
  }
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(exit || (failed ? 1 : 0));
