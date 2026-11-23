// End-to-end: noise suppression is requested on the live microphone and the toggle really restarts the track
// with the new setting (state is read back from the browser's MediaStreamTrack settings, not from the UI state).
import { chromium } from 'playwright-core';
import { BASE } from './kc.mjs';

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
let exit = 0;
try {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  await page.goto(BASE + '/app');
  await page.getByRole('button', { name: /Sign in|Kirish|Войти/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', 'user.demo');
  await page.fill('#password', PASSWORD);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });

  const title = `Noise ${Date.now()}`;
  await page.getByTestId('new-meeting').click();
  await page.fill('[data-testid=meeting-title]', title);
  await page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await page.waitForSelector(`li:has-text("${title}")`);
  const code = (await page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  await page.locator('[data-testid=join-form]').locator('input[inputmode=numeric]').fill(code);
  await page.locator('[data-testid=join-form]').getByRole('button').click();
  await page.waitForSelector('.call', { timeout: 30000 });

  // Noise suppression lives in the "More" panel of the control bar.
  const openMore = async () => {
    if (!(await page.getByTestId('noise').isVisible())) await page.getByTestId('more').click();
    await page.getByTestId('noise').waitFor({ state: 'visible' });
  };
  await openMore();
  const state = () => page.getByTestId('noise').getAttribute('data-state');
  await page.waitForFunction(() => document.querySelector('[data-testid=noise]')?.getAttribute('data-state') !== 'null', null, { timeout: 20000 }).catch(() => undefined);
  const initial = await state();
  check('noise suppression is on by default on the live microphone', initial === 'true', `state=${initial}`);

  await openMore();
  await page.locator('label:has([data-testid=noise])').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=noise]')?.getAttribute('data-state') === 'false', null, { timeout: 15000 }).catch(() => undefined);
  const off = await state();
  check('the toggle restarts the microphone with noise suppression off', off === 'false', `state=${off}`);

  await openMore();
  await page.locator('label:has([data-testid=noise])').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=noise]')?.getAttribute('data-state') === 'true', null, { timeout: 15000 }).catch(() => undefined);
  const on = await state();
  check('and back on', on === 'true', `state=${on}`);
  await ctx.close();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  exit = 1;
} finally {
  await browser.close();
}
if (results.some((r) => !r)) exit = 1;
console.log(exit === 0 ? 'NOISE E2E: ALL PASSED' : 'NOISE E2E: FAILURES');
process.exit(exit);
