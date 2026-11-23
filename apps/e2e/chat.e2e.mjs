// End-to-end: in-meeting chat (public and private), unread counter, raised hand and reactions, three real
// browser participants over the LiveKit data channel. Chat text must render as plain text (no markup).
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
  await page.goto(BASE + '/app');
  await page.getByRole('button', { name: /Sign in|Kirish|Войти/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  return { ctx, page, username };
}
const joinByCode = async (page, code) => {
  const form = page.locator('[data-testid=join-form]');
  await form.locator('input[inputmode=numeric]').fill(code);
  await form.getByRole('button').click();
  await page.waitForSelector('.call', { timeout: 30000 });
};
const lines = (page) => page.locator('[data-testid=chat-line]');

const b = await createUser();
const c = await createUser();
let exit = 0;
try {
  const host = await open('user.demo', PASSWORD);
  const pb = await open(b.username, b.password);
  const pc = await open(c.username, c.password);

  const title = `Chat ${Date.now()}`;
  await host.page.getByTestId('new-meeting').click();
  await host.page.fill('[data-testid=meeting-title]', title);
  await host.page.getByTestId('waiting-room').uncheck(); // keep this test about chat, not admission
  await host.page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await host.page.waitForSelector(`li:has-text("${title}")`);
  const code = (await host.page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  await joinByCode(host.page, code);
  await joinByCode(pb.page, code);
  await joinByCode(pc.page, code);
  for (const p of [host.page, pb.page, pc.page]) {
    await p.waitForFunction(() => document.querySelectorAll('.grid .tile[data-identity]').length >= 3, null, { timeout: 40000 });
  }

  // Host and B open the chat; C keeps it closed to see the unread counter.
  await host.page.getByTestId('chat-toggle').click();
  await pb.page.getByTestId('chat-toggle').click();

  const markup = 'hello <b>all</b> <img src=x onerror=alert(1)>';
  await host.page.getByTestId('chat-input').fill(markup);
  await host.page.getByTestId('chat-input').press('Enter');
  await pb.page.waitForSelector('[data-testid=chat-line]', { timeout: 20000 });
  const bText = await lines(pb.page).first().locator('.chat-text').innerText();
  const injected = await pb.page.locator('[data-testid=chat-lines] b, [data-testid=chat-lines] img').count();
  check('a public message reaches the others and markup is shown as literal text', bText === markup && injected === 0);

  await pc.page.waitForFunction(() => document.querySelector('[data-testid=chat-toggle]')?.textContent.includes('(1)'), null, { timeout: 20000 });
  check('a participant with the chat closed sees an unread counter', true);
  await pc.page.getByTestId('chat-toggle').click();
  check('opening the chat shows the message', (await lines(pc.page).count()) === 1);

  // Empty input is not sent.
  await host.page.getByTestId('chat-input').fill('   ');
  await host.page.getByTestId('chat-input').press('Enter');
  await host.page.waitForTimeout(1500);
  check('whitespace-only input sends nothing', (await lines(host.page).count()) === 1);

  // Private message from B to the host: C must not receive it.
  const hostIdentity = await host.page.locator('.tile[data-identity]').first().getAttribute('data-identity');
  await pb.page.getByTestId('chat-target').selectOption(hostIdentity);
  await pb.page.getByTestId('chat-input').fill('only for you, host');
  await pb.page.getByTestId('chat-input').press('Enter');
  await host.page.waitForFunction(() => document.querySelectorAll('[data-testid=chat-line]').length >= 2, null, { timeout: 20000 });
  const hostLast = lines(host.page).last();
  check('the host receives the private message, marked as private', (await hostLast.innerText()).includes('only for you, host') && /private|shaxsiy|личное/.test(await hostLast.innerText()));
  await pc.page.waitForTimeout(3000);
  check('a third participant does NOT receive someone else\'s private message', (await lines(pc.page).count()) === 1);

  // Raised hand: visible to the others, removable.
  await pb.page.getByTestId('hand').click();
  const handShown = await host.page
    .waitForFunction(() => Array.from(document.querySelectorAll('.tile[data-identity] .label')).some((l) => l.textContent.includes('✋')), null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  await pb.page.getByTestId('hand').click();
  const handGone = await host.page
    .waitForFunction(() => !Array.from(document.querySelectorAll('.tile[data-identity] .label')).some((l) => l.textContent.includes('✋')), null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('a raised hand shows on the participant tile and disappears when lowered', handShown && handGone);

  // Reaction from C appears for the host.
  // Reactions live in a popover of the control bar.
  if (!(await pc.page.getByTestId('react-🎉').isVisible())) await pc.page.getByTestId('reactions').click();
  await pc.page.getByTestId('react-🎉').click();
  const reacted = await host.page
    .waitForFunction(() => Array.from(document.querySelectorAll('[data-testid=reaction]')).some((r) => r.textContent === '🎉'), null, { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('a reaction pops up on the sender\'s tile for everyone', reacted);

  for (const x of [host, pb, pc]) await x.ctx.close();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  exit = 1;
} finally {
  await browser.close();
  await b.cleanup();
  await c.cleanup();
}
if (results.some((r) => !r)) exit = 1;
console.log(exit === 0 ? 'CHAT E2E: ALL PASSED' : 'CHAT E2E: FAILURES');
process.exit(exit);
