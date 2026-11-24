// End-to-end: the host appoints a co-host from the participant tile; the co-host's call screen gains the host
// controls live (no rejoin), and loses them again when dismissed.
import { chromium } from 'playwright-core';
import { BASE, createUser } from './kc.mjs';

const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};
const PASSWORD = process.env.DEMO_USER_PASSWORD;
if (!PASSWORD) throw new Error('DEMO_USER_PASSWORD is required (source scripts/devenv.sh)');
const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
async function open(username, password) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(() => localStorage.setItem('skipPreJoin', '1'));
  const page = await ctx.newPage();
  await page.goto(BASE + '/app');
  await page.getByRole('button', { name: /^(Sign in|Kirish|Войти)$/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  return { ctx, page };
}
const joinByCode = async (page, code) => {
  const form = page.locator('[data-testid=join-form]');
  await form.locator('input[inputmode=numeric]').fill(code);
  await form.getByRole('button').click();
  await page.waitForSelector('.call', { timeout: 30000 });
};

const b = await createUser();
let exit = 0;
try {
  const host = await open('user.demo', PASSWORD);
  const pb = await open(b.username, b.password);
  const title = `Cohost ${Date.now()}`;
  await host.page.getByTestId('new-meeting').click();
  await host.page.fill('[data-testid=meeting-title]', title);
  await host.page.getByTestId('waiting-room').uncheck();
  await host.page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await host.page.waitForSelector(`li:has-text("${title}")`);
  const code = (await host.page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  await joinByCode(host.page, code);
  await joinByCode(pb.page, code);
  await host.page.waitForFunction(() => document.querySelectorAll('.grid .tile[data-identity]').length >= 2, null, { timeout: 40000 });

  check('a plain member has no lock button and no host badge', (await pb.page.getByTestId('lock').count()) === 0 && (await pb.page.getByTestId('role-badge').count()) === 0);
  check('only the real host sees the co-host button on a tile', (await host.page.getByTestId('cohost-toggle').count()) === 1 && (await pb.page.getByTestId('cohost-toggle').count()) === 0);

  await host.page.getByTestId('cohost-toggle').click();
  await pb.page.waitForSelector('[data-testid=lock]', { timeout: 15000 });
  const badge = await pb.page.getByTestId('role-badge').innerText();
  check('promotion reaches the co-host live: lock button and a co-host badge appear', /co-host|соорганизатор/i.test(badge), badge);
  check('the co-host still cannot appoint co-hosts', (await pb.page.getByTestId('cohost-toggle').count()) === 0);

  await pb.page.getByTestId('lock').click();
  await pb.page.waitForFunction(() => document.querySelector('[data-testid=lock]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 15000 });
  check('the co-host can lock the meeting', true);
  await pb.page.getByTestId('lock').click();

  await host.page.getByTestId('cohost-toggle').click();
  const revoked = await pb.page
    .waitForFunction(() => !document.querySelector('[data-testid=lock]'), null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('dismissing removes the controls from the co-host live', revoked);

  for (const x of [host, pb]) await x.ctx.close();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  exit = 1;
} finally {
  await browser.close();
  await b.cleanup();
}
if (results.some((r) => !r)) exit = 1;
console.log(exit === 0 ? 'COHOST E2E: ALL PASSED' : 'COHOST E2E: FAILURES');
process.exit(exit);
