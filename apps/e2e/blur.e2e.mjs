// End-to-end: background blur. The toggle must load the self-hosted model and WASM (no request to any other
// origin), keep the camera live, measurably soften the outgoing picture, and turn off again.
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
  const origin = new URL(BASE).origin;
  const foreign = new Set();
  const consoleErrors = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['data:', 'blob:'].includes(u.protocol) && u.origin !== origin && !u.hostname.endsWith('localhost') && !/^(wss?|https?):$/.test('x')) foreign.add(u.origin);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content.Security.Policy|Refused to/i.test(m.text())) consoleErrors.push(m.text().slice(0, 160));
  });

  await page.goto(BASE + '/');
  await page.getByRole('button', { name: /Sign in|Kirish|Войти/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', 'user.demo');
  await page.fill('#password', PASSWORD);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  const title = `Blur ${Date.now()}`;
  await page.fill('input[placeholder]:not([type=password])', title);
  await page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await page.waitForSelector(`li:has-text("${title}")`);
  const code = (await page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  await page.locator('form').nth(1).locator('input[inputmode=numeric]').fill(code);
  await page.locator('form').nth(1).getByRole('button').click();
  await page.waitForSelector('.call', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('.tile[data-identity] video')?.videoWidth > 0, null, { timeout: 30000 });
  foreign.clear(); // only requests made from now on matter: the blur assets
  // Background blur lives in the "More" panel of the control bar.
  const openMore = async () => {
    if (!(await page.getByTestId('blur').isVisible())) await page.getByTestId('more').click();
    await page.getByTestId('blur').waitFor({ state: 'visible' });
  };

  // Share of pixels that sit on a hard edge (neighbour difference > 40) in the local video at 640x360: blur removes them.
  const sharpness = () =>
    page.evaluate(async () => {
      const v = document.querySelector('.tile[data-identity] video');
      const W = 640;
      const H = 360;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d', { willReadFrequently: true });
      let total = 0;
      for (let k = 0; k < 6; k++) {
        g.drawImage(v, 0, 0, W, H);
        const d = g.getImageData(0, 0, W, H).data;
        let hard = 0;
        for (let i = 4; i < d.length; i += 4) {
          const diff = Math.abs(d[i] - d[i - 4]) + Math.abs(d[i + 1] - d[i - 3]) + Math.abs(d[i + 2] - d[i - 2]);
          if (diff > 40) hard++;
        }
        total += (hard / (d.length / 4)) * 1000; // per mille
        await new Promise((r) => setTimeout(r, 120));
      }
      return total / 6;
    });

  const before = await sharpness();
  await openMore();
  await page.getByTestId('blur').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=blur]')?.getAttribute('data-state') === 'true', null, { timeout: 60000 });
  check('the blur toggle turns on (model and WASM loaded)', true);
  await page.waitForTimeout(2500);
  const live = await page.evaluate(() => {
    const v = document.querySelector('.tile[data-identity] video');
    return v.videoWidth > 0 && !v.paused;
  });
  check('the camera stays live while blurred', live);
  const after = await sharpness();
  check('the picture is measurably softer with blur on', after < before * 0.85, `sharpness ${before.toFixed(2)} -> ${after.toFixed(2)}`);
  check('no request left our own origin (no CDN, no third party)', foreign.size === 0, [...foreign].join(','));
  check('no Content-Security-Policy violation in the console', consoleErrors.length === 0, consoleErrors[0] ?? '');

  await openMore();
  await page.getByTestId('blur').click();
  await page.waitForFunction(() => document.querySelector('[data-testid=blur]')?.getAttribute('data-state') === 'false', null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  const restored = await sharpness();
  check('turning blur off restores the sharp picture', restored > after * 1.1, `sharpness ${after.toFixed(2)} -> ${restored.toFixed(2)}`);
  await ctx.close();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  exit = 1;
} finally {
  await browser.close();
}
if (results.some((r) => !r)) exit = 1;
console.log(exit === 0 ? 'BLUR E2E: ALL PASSED' : 'BLUR E2E: FAILURES');
process.exit(exit);
