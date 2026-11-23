// End-to-end: Davra, grid and speaker views. The featured tile is a screen sharer, else the last active speaker,
// else the first remote participant (never yourself unless nobody else is there); the view switch is a segmented control.
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
  const form = page.locator('[data-testid=join-form]');
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
  await host.page.getByTestId('new-meeting').click();
  await host.page.fill('[data-testid=meeting-title]', title);
  await host.page.getByTestId('waiting-room').uncheck();
  await host.page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await host.page.waitForSelector(`li:has-text("${title}")`);
  const code = (await host.page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  await joinByCode(host.page, code);
  await joinByCode(pb.page, code);
  await host.page.waitForFunction(() => document.querySelectorAll('.grid .tile[data-identity]').length >= 2, null, { timeout: 40000 });

  const layout = () => host.page.getByTestId('grid').getAttribute('data-layout');
  // The view switch is a popover with a three-way segmented control (Davra / Grid / Speaker).
  const pick = async (mode) => {
    if (!(await host.page.getByTestId(`layout-${mode}`).isVisible())) await host.page.getByTestId('layout').click();
    await host.page.getByTestId(`layout-${mode}`).click();
    await host.page.waitForFunction((m) => document.querySelector('[data-testid=grid]')?.getAttribute('data-layout') === m, mode, { timeout: 5000 });
  };
  const featured = () => host.page.locator('.grid .tile.featured:not(.share)');
  const isSelf = async (loc) => /\((You|Siz|Вы)\)/.test(await loc.locator('.label').innerText());

  // DOM order is stable in every view (yourself first); the layout only moves tiles with transforms.
  check('Davra is the default: yourself first in the DOM, another participant in the centre', (await layout()) === 'davra' && /\((You|Siz|Вы)\)/.test(await firstLabel(host.page)) && (await featured().count()) === 1 && !(await isSelf(featured())) && (await featured().getAttribute('data-slot')) === 'center');
  check('in Davra mode the participants are on the ring', (await host.page.locator('.grid .tile[data-slot=ring]').count()) === 1);

  await pick('speaker');
  check('speaker view features another participant, not yourself', (await layout()) === 'speaker' && (await featured().count()) === 1 && !(await isSelf(featured())) && (await featured().getAttribute('data-slot')) === 'main');

  await pick('gallery');
  check('grid view has no featured tile and keeps yourself first', (await layout()) === 'gallery' && (await featured().count()) === 0 && /\((You|Siz|Вы)\)/.test(await firstLabel(host.page)));

  await pick('davra');
  check('switching back restores Davra', (await layout()) === 'davra' && (await featured().count()) === 1);

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
