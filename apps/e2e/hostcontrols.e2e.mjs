// End-to-end: host controls through the real UI.
// mute a participant, lock the meeting, deny a request, remove (ban) a participant.
// Chromium runs with fake media devices, so every participant publishes a real microphone track.
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
const joinForm = (page) => page.locator('[data-testid=join-form]');
async function joinByCode(page, code) {
  await joinForm(page).locator('input[inputmode=numeric]').fill(code);
  await joinForm(page).getByRole('button').click();
}

const b = await createUser();
const c = await createUser();
let exit = 0;
try {
  const host = await open('user.demo', PASSWORD);
  const userB = await open(b.username, b.password);
  const userC = await open(c.username, c.password);

  const title = `Controls ${Date.now()}`;
  await host.page.getByTestId('new-meeting').click();
  await host.page.fill('[data-testid=meeting-title]', title);
  await host.page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await host.page.waitForSelector(`li:has-text("${title}")`);
  const code = (await host.page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  await joinByCode(host.page, code);
  await host.page.waitForSelector('.call', { timeout: 20000 });

  // B asks to join and is admitted.
  await joinByCode(userB.page, code);
  await userB.page.waitForSelector('[data-testid=waiting]', { timeout: 20000 });
  await host.page.waitForSelector('[data-testid=join-request]', { timeout: 20000 });
  await host.page.locator('[data-testid=join-request] button.primary').click();
  await userB.page.waitForSelector('.call', { timeout: 30000 });
  await host.page.waitForFunction(() => document.querySelectorAll('.grid .tile').length >= 2, null, { timeout: 30000 });
  const bTile = host.page.locator('.tile[data-identity]').nth(1);

  // Wait for B's microphone to reach the host unmuted, then mute B from the host.
  await host.page.waitForFunction(() => {
    const tile = document.querySelectorAll('.grid .tile[data-identity]')[1];
    return !!tile && !tile.textContent.includes('🔇') && !!tile.querySelector('audio');
  }, null, { timeout: 30000 }).catch(() => undefined);
  const mutedBefore = (await bTile.locator('.label').innerText()).includes('🔇');
  await bTile.getByRole('button', { name: /Mute|Ovozni o‘chirish|Выключить звук/ }).click();
  const mutedAfter = await host.page
    .waitForFunction(() => document.querySelectorAll('.grid .tile[data-identity]')[1]?.textContent.includes('🔇'), null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('host mutes a participant: their tile turns muted', !mutedBefore && mutedAfter);

  // Lock: C cannot even ask to join.
  await host.page.getByTestId('lock').click();
  await host.page.waitForFunction(() => document.querySelector('[data-testid=lock]')?.getAttribute('aria-pressed') === 'true');
  await joinByCode(userC.page, code);
  await userC.page.waitForSelector('[role=alert]', { timeout: 15000 });
  check('a locked meeting refuses a new participant with a visible error', (await userC.page.locator('[data-testid=waiting], .call').count()) === 0);

  // Unlock, C asks, the host denies.
  await host.page.getByTestId('lock').click();
  await host.page.waitForFunction(() => document.querySelector('[data-testid=lock]')?.getAttribute('aria-pressed') === 'false');
  await joinByCode(userC.page, code);
  await userC.page.waitForSelector('[data-testid=waiting]', { timeout: 20000 });
  await host.page.waitForSelector('[data-testid=join-request]', { timeout: 20000 });
  await host.page.locator('[data-testid=join-request] button:not(.primary)').click();
  await userC.page.waitForSelector('[role=alert]', { timeout: 20000 });
  check('a denied participant is sent back with an error and never enters the call', (await userC.page.locator('.call').count()) === 0);

  // Remove B: B's call ends, rejoining is refused.
  await bTile.getByRole('button', { name: /Remove|Chiqarib yuborish|Удалить из встречи/ }).click();
  await host.page.getByTestId('remove-confirm').click();
  await userB.page.waitForSelector('.home', { timeout: 30000 });
  check('a removed participant is dropped from the call', (await userB.page.locator('.call').count()) === 0);
  await joinByCode(userB.page, code);
  await userB.page.waitForSelector('[role=alert]', { timeout: 15000 });
  check('a removed participant cannot rejoin (banned)', (await userB.page.locator('.call, [data-testid=waiting]').count()) === 0);

  for (const x of [host, userB, userC]) await x.ctx.close();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  exit = 1;
} finally {
  await browser.close();
  await b.cleanup();
  await c.cleanup();
}
if (results.some((r) => !r)) exit = 1;
console.log(exit === 0 ? 'HOST CONTROLS E2E: ALL PASSED' : 'HOST CONTROLS E2E: FAILURES');
process.exit(exit);
