// End-to-end: the admin console in a real browser against the real API and Keycloak.
// An organization admin sees every section and can open the create-user dialog; a plain member gets the "no access" page.
import { chromium } from 'playwright-core';
import { BASE, createUser } from './kc.mjs';

const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};
const PASSWORD = process.env.DEMO_USER_PASSWORD;
if (!PASSWORD) throw new Error('DEMO_USER_PASSWORD is required (source scripts/devenv.sh)');
const browser = await chromium.launch({ channel: 'msedge' });

async function openAdmin(username, password, locale = 'en-US') {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale });
  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: /Sign in|Kirish|Войти/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  await page.goto(BASE + '/admin');
  return { ctx, page };
}

const member = await createUser();
let exit = 0;
try {
  const a = await openAdmin('admin.demo', PASSWORD);
  await a.page.waitForSelector('.adm-nav', { timeout: 20000 });
  const items = await a.page.locator('.adm-nav button').count();
  check('an organization admin sees the five sections', items === 5, `sections=${items}`);

  await a.page.waitForSelector('.stat', { timeout: 15000 });
  check('the overview shows the organization numbers', (await a.page.locator('.stat').count()) >= 4);

  await a.page.locator('.adm-nav button').nth(1).click();
  await a.page.waitForSelector('table.data tbody tr', { timeout: 15000 });
  check('the users table lists people with a role badge and a status badge', (await a.page.locator('table.data tbody tr .dx-badge').count()) >= 2);

  await a.page.getByRole('button', { name: /Create user|Foydalanuvchi qo|Создать/ }).click();
  await a.page.waitForSelector('dialog.dx-dialog[open]', { timeout: 5000 });
  check('the create-user dialog opens as a modal', (await a.page.locator('dialog.dx-dialog[open] form').count()) === 1);
  await a.page.keyboard.press('Escape');
  await a.page.waitForFunction(() => !document.querySelector('dialog.dx-dialog[open]'), null, { timeout: 5000 });
  check('Escape closes the dialog', true);

  await a.page.locator('.adm-nav button').nth(4).click();
  await a.page.waitForSelector('#sec-audit', { timeout: 15000 });
  check('the audit section opens', true);

  const m = await openAdmin(member.username, member.password);
  const denied = await m.page
    .waitForSelector('[data-testid=admin-no-access]', { timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  check('a plain member is shown the no-access page', denied);

  for (const x of [a, m]) await x.ctx.close();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  exit = 1;
} finally {
  await browser.close();
  await member.cleanup();
}
if (results.some((r) => !r)) exit = 1;
console.log(exit === 0 ? 'ADMIN E2E: ALL PASSED' : 'ADMIN E2E: FAILURES');
process.exit(exit);
