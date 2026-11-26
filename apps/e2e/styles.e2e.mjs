// End-to-end: look preferences follow the person and obey the organization (real browser, real API).
// The admin allows two styles with one as the default; a member signs in and gets it, can pick only the allowed ones, and the
// choice follows them into a fresh browser (server side). Everything is put back at the end.
import { chromium } from 'playwright-core';
import { BASE, createUser } from './kc.mjs';
import { listOptions, pickOption } from './pick.mjs';

const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};
const PASSWORD = process.env.DEMO_USER_PASSWORD;
if (!PASSWORD) throw new Error('DEMO_USER_PASSWORD is required (source scripts/devenv.sh)');
const browser = await chromium.launch({ channel: 'msedge' });

async function login(username, path = '/app', password = PASSWORD) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' });
  await ctx.addInitScript(() => localStorage.setItem('skipPreJoin', '1'));
  const page = await ctx.newPage();
  await page.goto(BASE + '/app');
  await page.getByRole('button', { name: /^(Sign in|Kirish|Войти)$/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  if (path !== '/app') await page.goto(BASE + path);
  return { ctx, page };
}
const attr = (page, name) => page.evaluate((n) => document.documentElement.getAttribute(n), name);

async function adminPolicy(admin, { all, allowed, def }) {
  await admin.page.goto(BASE + '/admin');
  await admin.page.waitForSelector('.adm-nav', { timeout: 20000 });
  await admin.page.locator('.adm-nav button', { hasText: /Polic|Siyosat|Политик/i }).click();
  await admin.page.waitForSelector('[data-testid=styles-all]', { timeout: 15000 });
  const allBox = admin.page.getByTestId('styles-all');
  if (all) {
    if (!(await allBox.isChecked())) await allBox.check();
  } else {
    if (await allBox.isChecked()) await allBox.uncheck();
    const ids = ['dashboard', 'swiss', 'flat', 'material', 'editorial', 'neobrutalism', 'terminal', 'glassmorphism', 'neumorphism', 'claymorphism', 'aurora', 'skeuomorphism', 'liquid-glass'];
    // Tick the wanted ones first: the form never lets the last allowed style be unticked.
    for (const id of [...ids.filter((i) => allowed.includes(i)), ...ids.filter((i) => !allowed.includes(i))]) {
      const box = admin.page.getByTestId(`style-allow-${id}`);
      if (allowed.includes(id) !== (await box.isChecked())) await box.setChecked(allowed.includes(id));
    }
  }
  await pickOption(admin.page, '[data-testid=default-style]', def);
  await admin.page.getByRole('button', { name: /Save|Saqlash|Сохранить/ }).click();
  await admin.page.waitForSelector('[role=status]:has-text("aved"), [role=status]:has-text("aqlandi"), [role=status]:has-text("охранено")', { timeout: 15000 });
}

const member = await createUser(); // a new member each run: someone who never chose a look
let admin;
try {
  admin = await login('admin.demo', '/admin');
  await adminPolicy(admin, { all: false, allowed: ['flat', 'terminal'], def: 'terminal' });
  check('the admin allows two styles and makes one the default', true);

  const m1 = await login(member.username, '/app', member.password);
  await m1.page.waitForFunction(() => document.documentElement.getAttribute('data-style') === 'terminal', null, { timeout: 15000 }).catch(() => undefined);
  check('a member who never chose gets the organization default style', (await attr(m1.page, 'data-style')) === 'terminal', await attr(m1.page, 'data-style'));

  await m1.page.getByTestId('settings').click();
  const options = await listOptions(m1.page, '[data-testid=style-select]');
  check('the style picker offers only the allowed styles', options.join() === 'flat,terminal', options.join());

  await pickOption(m1.page, '[data-testid=style-select]', 'flat');
  await m1.page.waitForFunction(() => document.documentElement.getAttribute('data-style') === 'flat');
  await m1.page.waitForTimeout(1500); // the change is sent to the server after a short pause
  check('choosing a style applies it at once', (await attr(m1.page, 'data-style')) === 'flat');

  const m2 = await login(member.username, '/app', member.password);
  await m2.page.waitForFunction(() => document.documentElement.getAttribute('data-style') === 'flat', null, { timeout: 15000 }).catch(() => undefined);
  check('the choice follows the person into a fresh browser (stored on the server)', (await attr(m2.page, 'data-style')) === 'flat', await attr(m2.page, 'data-style'));

  // The organization narrows the list: the stored style is no longer allowed, the default takes over.
  await adminPolicy(admin, { all: false, allowed: ['terminal'], def: 'terminal' });
  const m3 = await login(member.username, '/app', member.password);
  await m3.page.waitForFunction(() => document.documentElement.getAttribute('data-style') === 'terminal', null, { timeout: 15000 }).catch(() => undefined);
  check('when the organization stops allowing a style, a fresh sign-in falls back to its default', (await attr(m3.page, 'data-style')) === 'terminal', await attr(m3.page, 'data-style'));
} catch (e) {
  check('unexpected error', false, String(e));
} finally {
  try {
    if (admin) await adminPolicy(admin, { all: true, allowed: [], def: 'dashboard' });
  } catch {
    /* best effort */
  }
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(failed === 0 ? `STYLES E2E: ALL PASSED (${results.length})` : 'STYLES E2E: FAILURES');
process.exit(failed === 0 ? 0 : 1);
