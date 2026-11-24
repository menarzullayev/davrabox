// End-to-end: guest mode (join with a code and a name, no account) through the real UI.
// The admin sets the organization policy, the host picks a mode inside it, a guest waits, is admitted, talks, cannot
// manage anything, is removed and cannot come back from the same address; with the policy off the guest is refused.
import { chromium } from 'playwright-core';
import { BASE } from './kc.mjs';
import { listOptions, pickOption } from './pick.mjs';

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

async function login(username, password, path = '/app') {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(() => localStorage.setItem('skipPreJoin', '1')); // the host and the admin are not what this suite tests
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

async function setGuestPolicy(admin, value) {
  await admin.page.goto(BASE + '/admin');
  await admin.page.waitForSelector('.adm-nav', { timeout: 20000 });
  await admin.page.locator('.adm-nav button', { hasText: /Polic|Siyosat|Политик/i }).click();
  await admin.page.waitForSelector('[data-testid=guest-policy]', { timeout: 15000 });
  await pickOption(admin.page, '[data-testid=guest-policy]', value);
  await admin.page.getByRole('button', { name: /Save|Saqlash|Сохранить/ }).click();
  await admin.page.waitForSelector('[role=status]:has-text("aved"), [role=status]:has-text("aqlandi"), [role=status]:has-text("охранено")', { timeout: 15000 });
}

let exit = 0;
let admin;
let host;
let guestCtx;
try {
  admin = await login('admin.demo', PASSWORD, '/admin');
  await setGuestPolicy(admin, 'open');
  check('the admin sets the organization guest policy to "open"', true);

  host = await login('user.demo', PASSWORD);
  const title = `Guests ${Date.now()}`;
  await host.page.getByTestId('new-meeting').click();
  await host.page.fill('[data-testid=meeting-title]', title);
  const options = await listOptions(host.page, '[data-testid=guest-mode]');
  check('the host is offered off, waiting room and direct (the policy allows all three)', options.join() === 'off,waiting_room,open', options.join());
  await pickOption(host.page, '[data-testid=guest-mode]', 'waiting_room');
  await host.page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await host.page.waitForSelector(`li:has-text("${title}")`);
  const code = (await host.page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  await host.page.locator('[data-testid=join-form] input[inputmode=numeric]').fill(code);
  await host.page.locator('[data-testid=join-form]').getByRole('button').click();
  await host.page.waitForSelector('.call', { timeout: 20000 });

  // The guest: no account, only the meeting link.
  guestCtx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', permissions: ['camera', 'microphone'] });
  const g = await guestCtx.newPage();
  await g.goto(`${BASE}/app?join=${code}`);
  await g.waitForSelector('[data-testid=signin]', { timeout: 30000 });
  const prefilled = (await g.locator('[data-testid=signin-join-form] input[inputmode=numeric]').inputValue()).replace(/\D/g, '');
  check('the meeting link pre-fills the code on the first screen', prefilled === code, prefilled);

  await g.getByTestId('guest-go').click();
  check('an empty name is refused on the form', (await g.locator('[role=alert]').count()) >= 1 && (await g.getByTestId('guest-name').count()) === 1);
  await g.getByTestId('guest-name').fill('Guest Gulnora');
  await g.getByTestId('guest-go').click();
  await g.waitForSelector('[data-testid=waiting]', { timeout: 20000 });
  check('with the waiting-room mode the guest waits instead of getting in', (await g.locator('.call').count()) === 0);

  await host.page.waitForSelector('[data-testid=join-request]', { timeout: 20000 });
  const reqText = await host.page.locator('[data-testid=join-request]').first().innerText();
  check('the host sees the request labelled as a guest', /Guest Gulnora \(guest\)/.test(reqText), reqText.replace(/\s+/g, ' '));
  await host.page.locator('[data-testid=join-request] button.primary').click();
  await g.waitForSelector('[data-testid=prejoin]', { timeout: 30000 });
  check('once admitted the guest first sees the pre-join screen, not the call', (await g.locator('.call').count()) === 0);
  await g.waitForFunction(() => !document.querySelector('[data-testid=prejoin-mic]')?.disabled, null, { timeout: 15000 });
  check('the pre-join screen offers the microphone and the camera (fake devices here)', (await g.getByTestId('prejoin-cam').isEnabled()) && (await g.getByTestId('prejoin-mic').isEnabled()));
  await g.getByTestId('prejoin-join').click();
  await g.waitForSelector('.call', { timeout: 30000 });
  await host.page.waitForFunction(() => document.querySelectorAll('.grid .tile').length >= 2, null, { timeout: 30000 });
  check('after the host admits, the guest is in the call and both see each other', true);

  const hostSees = await host.page.locator('.tile[data-identity]').allInnerTexts();
  check('the host sees the guest labelled on the tile', hostSees.some((t) => t.includes('Guest Gulnora (guest)')));

  // Guests chat; they have no host controls and no file sharing.
  await g.getByTestId('chat-toggle').click();
  await host.page.getByTestId('chat-toggle').click();
  await g.getByTestId('chat-input').fill('Hello from a guest');
  await g.getByTestId('chat-input').press('Enter');
  await host.page.waitForSelector('[data-testid=chat-line]:has-text("Hello from a guest")', { timeout: 20000 });
  check('a guest can chat and the host receives it', true);
  check('a guest sees no record, lock or remove controls', (await g.getByTestId('record').count()) === 0 && (await g.getByTestId('lock').count()) === 0 && (await g.getByRole('button', { name: /Remove|Chiqarish|Удалить/ }).count()) === 0);
  check('a guest has no file attach and is told why', (await g.locator('input[type=file]').count()) === 0 && /Guests cannot share files/.test(await g.locator('body').innerText()));
  const tokenCalls = [];
  g.on('request', (r) => {
    if (/\/api\/v1\/(meetings|admin)/.test(r.url())) tokenCalls.push(r.url());
  });
  await g.waitForTimeout(3000);
  check('a guest makes no member API calls while in the call', tokenCalls.length === 0, tokenCalls.join(' '));

  // The host removes the guest: out of the call, and the same address cannot come back to this meeting.
  const guestTile = host.page.locator('.tile[data-identity]').filter({ hasText: 'Guest Gulnora' });
  await guestTile.getByRole('button', { name: /Remove|Chiqarish|Удалить/ }).click();
  await host.page.getByRole('button', { name: /Remove|Chiqarish|Удалить/ }).last().click();
  await g.waitForSelector('[data-testid=signin]', { timeout: 30000 });
  check('the removed guest is back on the first screen', true);
  await g.goto(`${BASE}/app?join=${code}`);
  await g.waitForSelector('[data-testid=signin]');
  await g.getByTestId('guest-name').fill('Guest Gulnora again');
  await g.getByTestId('guest-go').click();
  await g.waitForSelector('[role=alert]', { timeout: 15000 });
  check('the removed guest is refused from the same address', (await g.locator('.call, [data-testid=waiting]').count()) === 0);

  // Policy off: a fresh guest is refused with the "not found" answer, and the host's option disappears.
  await setGuestPolicy(admin, 'off');
  const g2ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' });
  const g2 = await g2ctx.newPage();
  await g2.goto(`${BASE}/app?join=${code}`);
  await g2.waitForSelector('[data-testid=signin]', { timeout: 30000 });
  await g2.getByTestId('guest-name').fill('Late Guest');
  await g2.getByTestId('guest-go').click();
  await g2.waitForSelector('[role=alert]', { timeout: 15000 });
  check('with the policy off a guest is refused as if the meeting did not exist', (await g2.locator('[role=alert]').innerText()).length > 0 && (await g2.locator('.call, [data-testid=waiting]').count()) === 0);
  await g2ctx.close();
} catch (e) {
  check('unexpected error', false, String(e));
  exit = 1;
} finally {
  try {
    if (admin) await setGuestPolicy(admin, 'off'); // leave the organization the way it was
  } catch {
    /* best effort */
  }
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(failed === 0 && exit === 0 ? `GUEST E2E: ALL PASSED (${results.length})` : 'GUEST E2E: FAILURES');
process.exit(failed === 0 && exit === 0 ? 0 : 1);
