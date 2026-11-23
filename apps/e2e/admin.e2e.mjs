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
  check('an organization admin sees the six sections', items === 6, `sections=${items}`);

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

  // Integrations: API keys and webhooks (secrets are shown once).
  await a.page.locator('.adm-nav button').nth(5).click();
  await a.page.waitForSelector('#sec-integrations', { timeout: 15000 });
  check('the integrations section opens with both blocks', (await a.page.locator('#sec-int-keys, #sec-int-hooks').count()) === 2);

  const keyName = `e2e-key-${Date.now()}`;
  await a.page.locator('section[aria-labelledby="sec-int-keys"] .toolbar button').first().click();
  await a.page.waitForSelector('dialog.dx-dialog[open] form', { timeout: 5000 });
  await a.page.fill('dialog.dx-dialog[open] input[maxlength="80"]', keyName);
  await a.page.locator('dialog.dx-dialog[open] button[type=submit]').click();
  await a.page.waitForSelector('[data-testid=int-secret]', { timeout: 10000 });
  const secret = await a.page.locator('[data-testid=int-secret]').inputValue();
  check('a new API key is shown once in the documented format', /^dbx_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/.test(secret));
  await a.page.getByRole('button', { name: /I copied it|Nusxa oldim|Скопировал/ }).click();
  await a.page.waitForFunction(() => !document.querySelector('[data-testid=int-secret]'), null, { timeout: 5000 });
  const keysText = await a.page.locator('[data-testid=int-keys]').innerText();
  check('the key list shows the prefix and name but never the secret', keysText.includes(keyName) && keysText.includes(secret.slice(4, 12)) && !keysText.includes(secret.slice(13)));
  const pageHtml = await a.page.content();
  check('the secret is gone from the page after the dialog is closed', !pageHtml.includes(secret.slice(13)));

  // the key really works against the external API (through the proxy used by the app)
  const ext = await a.page.evaluate(async (k) => {
    const r = await fetch('/api/v1/ext/meetings?limit=1', { headers: { Authorization: `Bearer ${k}` } });
    return r.status;
  }, secret);
  check('the new key authenticates against /v1/ext', ext === 200, `status=${ext}`);

  await a.page.getByRole('button', { name: new RegExp(`(Revoke|Bekor qilish|Отозвать): ${keyName}`) }).click();
  await a.page.waitForSelector('dialog.dx-dialog[open]', { timeout: 5000 });
  await a.page.locator('dialog.dx-dialog[open] button.danger').click();
  await a.page.waitForFunction(() => !document.querySelector('dialog.dx-dialog[open]'), null, { timeout: 10000 });
  const afterRevoke = await a.page.evaluate(async (k) => (await fetch('/api/v1/ext/meetings?limit=1', { headers: { Authorization: `Bearer ${k}` } })).status, secret);
  check('a revoked key stops working at once', afterRevoke === 401, `status=${afterRevoke}`);

  // webhooks: a private target is refused, a public one is accepted and its secret is shown once
  await a.page.locator('section[aria-labelledby="sec-int-hooks"] .toolbar button').first().click();
  await a.page.waitForSelector('dialog.dx-dialog[open] form', { timeout: 5000 });
  await a.page.fill('dialog.dx-dialog[open] input[type=url]', 'https://127.0.0.1/hook');
  await a.page.locator('dialog.dx-dialog[open] button[type=submit]').click();
  const refused = await a.page.waitForSelector('dialog.dx-dialog[open] [role=alert]', { timeout: 10000 }).then(() => true).catch(() => false);
  check('a webhook URL pointing at a loopback address is refused', refused);
  const hookUrl = `https://example.com/davra-e2e-${Date.now()}`;
  await a.page.fill('dialog.dx-dialog[open] input[type=url]', hookUrl);
  await a.page.locator('dialog.dx-dialog[open] button[type=submit]').click();
  await a.page.waitForSelector('[data-testid=int-secret]', { timeout: 15000 });
  const hookSecret = await a.page.locator('[data-testid=int-secret]').inputValue();
  check('a webhook signing secret is shown once', /^whsec_[A-Za-z0-9_-]{43}$/.test(hookSecret));
  await a.page.getByRole('button', { name: /I copied it|Nusxa oldim|Скопировал/ }).click();
  await a.page.waitForFunction(() => !document.querySelector('[data-testid=int-secret]'), null, { timeout: 5000 });
  const hooksText = await a.page.locator('[data-testid=int-hooks]').innerText();
  check('the webhook list shows the URL and never the secret', hooksText.includes(hookUrl) && !hooksText.includes(hookSecret.slice(6)));
  await a.page.getByRole('button', { name: /(Deliveries|Yetkazib berishlar|Доставки): example\.com/ }).first().click();
  await a.page.waitForSelector('dialog.dx-dialog[open]', { timeout: 5000 });
  check('the delivery log dialog opens', (await a.page.locator('dialog.dx-dialog[open] select').count()) === 1);
  await a.page.keyboard.press('Escape');
  await a.page.waitForFunction(() => !document.querySelector('dialog.dx-dialog[open]'), null, { timeout: 5000 });
  await a.page.getByRole('button', { name: /(Delete|O‘chirish|Удалить): example\.com/ }).first().click();
  await a.page.waitForSelector('dialog.dx-dialog[open]', { timeout: 5000 });
  await a.page.locator('dialog.dx-dialog[open] button.danger').click();
  await a.page.waitForFunction(() => !document.querySelector('dialog.dx-dialog[open]'), null, { timeout: 10000 });
  check('the webhook can be deleted', !(await a.page.locator('[data-testid=int-hooks]').innerText().catch(() => '')).includes(hookUrl));

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
