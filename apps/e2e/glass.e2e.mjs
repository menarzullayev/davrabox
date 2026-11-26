// End-to-end: the liquid-glass style in a real call (real browser, real API, real LiveKit).
// Refraction is on in Edge (Chromium), the call's floating glass refracts the video, and the automatic degradation works:
// reduced transparency, battery saver and a low frame rate switch to CSS glass, and the glass comes back when they clear.
// The low frame rate is simulated by slowing requestAnimationFrame (what the runtime measures); the real frame-rate gate is
// the phone measurement (docs/liquid-glass.md).
import { chromium } from 'playwright-core';
import { BASE } from './kc.mjs';
import { forceStyle } from './style-hook.mjs';

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

/** A fake Battery API (before the app loads): low and discharging until `window.__charge()` is called. */
const fakeBattery = () => {
  const b = new EventTarget();
  b.level = 0.1;
  b.charging = false;
  navigator.getBattery = () => Promise.resolve(b);
  window.__charge = () => {
    b.charging = true;
    b.dispatchEvent(new Event('chargingchange'));
  };
};
/** requestAnimationFrame that can be slowed to ~15 frames per second (`window.__slow = true`). */
const slowFrames = () => {
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => (window.__slow ? setTimeout(() => cb(performance.now()), 66) : raf(cb));
};

async function signIn({ battery = false } = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', permissions: ['camera', 'microphone'], viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => localStorage.setItem('skipPreJoin', '1'));
  await forceStyle(ctx, 'liquid-glass');
  await ctx.addInitScript(slowFrames);
  if (battery) await ctx.addInitScript(fakeBattery);
  const page = await ctx.newPage();
  await page.goto(BASE + '/app');
  await page.getByRole('button', { name: /^(Sign in|Kirish|Войти)$/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', 'user.demo');
  await page.fill('#password', PASSWORD);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  return { ctx, page };
}
const glass = (page) => page.evaluate(() => ({ mode: document.documentElement.getAttribute('data-glass'), reason: document.documentElement.getAttribute('data-glass-reason'), ...(window.__davraGlass?.status() ?? {}) }));
const toolbarFilter = (page) => page.evaluate(() => getComputedStyle(document.querySelector('.dv-toolbar')).backdropFilter);
const waitMode = (page, mode, reason, timeout = 15000) =>
  page
    .waitForFunction(([m, r]) => document.documentElement.getAttribute('data-glass') === m && (r === undefined || document.documentElement.getAttribute('data-glass-reason') === r), [mode, reason], { timeout })
    .then(() => true)
    .catch(() => false);

try {
  const a = await signIn();
  check('liquid-glass is applied and refracts in Edge (Chromium)', (await glass(a.page)).mode === 'refract', JSON.stringify(await glass(a.page)));
  check('the phone tab bar is shown in this style', await a.page.getByTestId('tab-new').isVisible());

  // A call of one's own: open a meeting from the tab bar and join it.
  const title = `Glass ${Date.now()}`;
  await a.page.getByTestId('tab-new').click();
  await a.page.fill('[data-testid=meeting-title]', title);
  await a.page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await a.page.waitForSelector(`li:has-text("${title}")`);
  const code = (await a.page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  await a.page.fill('input[inputmode=numeric]', code);
  await a.page.locator('[data-testid=join-form]').getByRole('button').click();
  await a.page.waitForSelector('.call', { timeout: 30000 });
  await a.page.waitForFunction(() => Array.from(document.querySelectorAll('.tile video')).some((v) => v.videoWidth > 0), null, { timeout: 30000 });
  await a.page.waitForTimeout(1500);

  const f = await toolbarFilter(a.page);
  check('the floating control bar refracts the video (SVG displacement in its backdrop filter)', /url\(/.test(f), f);
  const s = await glass(a.page);
  check('the runtime built filters for the call surfaces and measures the frame rate', s.surfaces >= 3 && typeof s.fps === 'number', JSON.stringify(s));

  // Reduced transparency: CSS glass at once, refraction again when it is lifted.
  const cdp = await a.ctx.newCDPSession(a.page);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  check('reduced transparency switches to CSS glass', await waitMode(a.page, 'css', 'reduced-transparency'));
  check('…and no refraction is drawn then', !/url\(/.test(await toolbarFilter(a.page)), await toolbarFilter(a.page));
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'no-preference' }] });
  check('lifting reduced transparency brings refraction back', await waitMode(a.page, 'refract'));

  // Low frame rate during the call: CSS glass after a few slow seconds, refraction retried after the back-off.
  await a.page.evaluate(() => (window.__slow = true));
  check('a sustained low call frame rate switches to CSS glass', await waitMode(a.page, 'css', 'low-fps', 15000), JSON.stringify(await glass(a.page)));
  await a.page.evaluate(() => (window.__slow = false));
  check('refraction is retried once the frame rate recovered (back-off)', await waitMode(a.page, 'refract', undefined, 35000), JSON.stringify(await glass(a.page)));

  // Leave the call.
  await a.page.getByTestId('leave').click().catch(() => undefined);
  await a.ctx.close();

  // Battery saver (Battery API: low and discharging), and back when charging.
  const b = await signIn({ battery: true });
  check('battery saver switches to CSS glass', await waitMode(b.page, 'css', 'battery-saver'), JSON.stringify(await glass(b.page)));
  await b.page.evaluate(() => window.__charge());
  check('charging again brings refraction back', await waitMode(b.page, 'refract'));

  // Another style: no glass runtime at all.
  await b.page.evaluate(() => document.documentElement.setAttribute('data-style', 'dashboard'));
  check('another style leaves no glass state behind', await b.page.evaluate(() => !document.documentElement.hasAttribute('data-glass') && !document.querySelector('svg[data-glass]')));
  await b.ctx.close();
} catch (e) {
  check('unexpected error', false, String(e));
} finally {
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(failed === 0 ? `GLASS E2E: ALL PASSED (${results.length})` : 'GLASS E2E: FAILURES');
process.exit(failed === 0 ? 0 : 1);
