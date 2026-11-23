// End-to-end: gallery and speaker views. Speaker view features another participant first (a screen sharer,
// then the last active speaker, then the first remote participant); the toggle switches back to gallery order.
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
  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: /Sign in|Kirish|Войти/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  return { ctx, page };
}
const joinByCode = async (page, code) => {
  const form = page.locator('form').nth(1);
  await form.locator('input[inputmode=numeric]').fill(code);
  await form.getByRole('button').click();
  await page.waitForSelector('.call', { timeout: 30000 });
};
const firstLabel = (page) => page.locator('.grid .tile[data-identity]').first().locator('.label').innerText();

const b = await createUser();
let exit = 0;
try {
  const host = await open('user.demo', PASSWORD);
  const pb = await open(b.username, b.password);
  const title = `Layout ${Date.now()}`;
  await host.page.fill('input[placeholder]:not([type=password])', title);
  await host.page.getByTestId('waiting-room').uncheck();
  await host.page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await host.page.waitForSelector(`li:has-text("${title}")`);
  const code = (await host.page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  await joinByCode(host.page, code);
  await joinByCode(pb.page, code);
  await host.page.waitForFunction(() => document.querySelectorAll('.grid .tile[data-identity]').length >= 2, null, { timeout: 40000 });

  const layout = () => host.page.getByTestId('grid').getAttribute('data-layout');
  check('gallery view is the default and lists yourself first', (await layout()) === 'gallery' && /\((You|Siz|Вы)\)/.test(await firstLabel(host.page)));

  await host.page.getByTestId('layout').click();
  check('speaker view features another participant, not yourself', (await layout()) === 'speaker' && !/\((You|Siz|Вы)\)/.test(await firstLabel(host.page)));
  check('exactly one tile is featured and it is the first one', (await host.page.locator('.tile.featured').count()) === 1 && (await host.page.locator('.grid .tile[data-identity]').first().getAttribute('class')).includes('featured'));

  await host.page.getByTestId('layout').click();
  check('switching back restores the gallery order', (await layout()) === 'gallery' && /\((You|Siz|Вы)\)/.test(await firstLabel(host.page)) && (await host.page.locator('.tile.featured').count()) === 0);

  for (const x of [host, pb]) await x.ctx.close();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  exit = 1;
} finally {
  await browser.close();
  await b.cleanup();
}
if (results.some((r) => !r)) exit = 1;
console.log(exit === 0 ? 'LAYOUT E2E: ALL PASSED' : 'LAYOUT E2E: FAILURES');
process.exit(exit);
