// End-to-end: "My settings" and organization locks (owner decisions of 2026-11-27) in real browsers against the real stack.
// Every rule is checked from the side of the person it restricts (server-side enforcement, not only hidden controls):
//  1. My settings: groups, search, saving; an admin lock shows a lock and the API refuses the change (403).
//  2. Join before host off: a colleague waits and gets in once the host is there.
//  3. In the call: start muted, chat "host only" (broadcast refused), reactions locked off, rename allowed.
//  4. Organization rules: join notice (accept to join), country block list (unknown country = XX, admins exempt).
//  5. Cancel: a cancelled meeting cannot be joined. 6. Lobby email arrives (Mailpit of the dev stack).
import { chromium } from 'playwright-core';
import { BASE, createUser } from './kc.mjs';
import { pickOption } from './pick.mjs';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:58025';
const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};
const PASSWORD = process.env.DEMO_USER_PASSWORD;
if (!PASSWORD) throw new Error('DEMO_USER_PASSWORD is required (source scripts/devenv.sh)');
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

async function login(username, password, path = '/app') {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', viewport: { width: 1366, height: 900 }, permissions: ['camera', 'microphone'] });
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
const tokenOf = (page) =>
  page.evaluate(() => {
    for (const s of [sessionStorage, localStorage]) for (let i = 0; i < s.length; i++) if (s.key(i)?.startsWith('oidc.user:')) return JSON.parse(s.getItem(s.key(i))).access_token;
    return null;
  });
const apiCall = async (page, method, path, body) =>
  page.evaluate(async ([m, p, b, t]) => {
    const r = await fetch(p, { method: m, headers: { Authorization: `Bearer ${t}`, ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [method, path, body, await tokenOf(page)]);
async function newMeeting(page, title, { waitingRoom = false } = {}) {
  const r = await apiCall(page, 'POST', '/api/v1/meetings', { title, waitingRoom });
  return r.body.code;
}
async function joinByCode(page, code) {
  await page.goto(BASE + '/app');
  await page.waitForSelector('.home');
  await page.fill('input[inputmode=numeric]', code);
  await page.locator('[data-testid=join-form]').getByRole('button').click();
}

const people = [];
let exit = 0;
let admin;
try {
  const a = await createUser();
  const b = await createUser();
  people.push(a, b);
  const host = await login(a.username, a.password);
  admin = await login('admin.demo', PASSWORD);

  // 1. My settings
  await host.page.getByTestId('nav-settings').click();
  await host.page.getByTestId('my-settings').waitFor();
  const groups = await host.page.locator('[data-testid^=ms-group-]').count();
  check('My settings shows the five groups (recording hidden while recording is off here or shown when on)', groups >= 5, String(groups));
  await host.page.getByTestId('ms-search').fill('lobby');
  check('search narrows the list', (await host.page.locator('[data-testid^=ms-group-]').count()) === 1);
  await host.page.getByTestId('ms-search').fill('');
  await pickOption(host.page, '[data-testid=set-chat]', 'host');
  await host.page.getByText('Saved').first().waitFor({ timeout: 10000 });
  for (const k of ['muteOnJoin', 'rename', 'emailLobby']) {
    const sw = host.page.getByTestId(`set-${k}`);
    if (!(await sw.isChecked())) await sw.click();
    await host.page.waitForTimeout(400);
  }
  const jbh = host.page.getByTestId('set-joinBeforeHost');
  if (await jbh.isChecked()) await jbh.click();
  await host.page.waitForTimeout(800);
  const mine = await apiCall(host.page, 'GET', '/api/v1/me/settings');
  const val = (k) => mine.body.items.find((i) => i.key === k)?.value;
  check('the choices are saved on the server', val('chat') === 'host' && val('muteOnJoin') === true && val('rename') === true && val('joinBeforeHost') === false, JSON.stringify({ chat: val('chat'), mute: val('muteOnJoin'), jbh: val('joinBeforeHost') }));

  // admin locks reactions off
  await admin.page.goto(BASE + '/admin#settings');
  await admin.page.getByTestId('org-settings').waitFor({ timeout: 20000 });
  const react = admin.page.getByTestId('os-reactions');
  if (await react.getByTestId('set-reactions').isChecked()) await react.getByTestId('set-reactions').click();
  await react.getByTestId('os-lock-reactions').click();
  await admin.page.getByTestId('os-save').click();
  await admin.page.getByText('Saved').first().waitFor({ timeout: 10000 });
  await host.page.reload({ waitUntil: 'domcontentloaded' });
  await host.page.getByTestId('my-settings').waitFor();
  check('a locked setting shows the lock and cannot be switched', (await host.page.getByTestId('ms-locked-reactions').isVisible()) && (await host.page.getByTestId('set-reactions').isDisabled()));
  const refused = await apiCall(host.page, 'PUT', '/api/v1/me/settings', { reactions: true });
  check('the server refuses a change of a locked setting', refused.status === 403, String(refused.status));

  // 2. join before host off
  const code = await newMeeting(host.page, `Settings ${Date.now()}`);
  const guest = await login(b.username, b.password);
  await joinByCode(guest.page, code);
  await guest.page.getByTestId('host-wait').waitFor({ timeout: 15000 });
  check('a colleague waits while the host is not there (join before host off)', true);
  await joinByCode(host.page, code);
  await host.page.waitForSelector('.call', { timeout: 30000 });
  await guest.page.waitForSelector('.call', { timeout: 30000 });
  check('the colleague gets in once the host has started', true);

  // 3. in the call
  await guest.page.waitForTimeout(3000);
  const micOff = await guest.page.evaluate(() => document.querySelector('[data-testid=mic]')?.hasAttribute('data-off') ?? null);
  check('the colleague starts muted (mute on entry)', micOff === true, String(micOff));
  await guest.page.getByTestId('chat-toggle').click();
  await guest.page.getByTestId('chat-input').fill('hello everyone');
  await guest.page.getByTestId('chat-input').press('Enter');
  await guest.page.getByText('In this meeting you can write to the host only').first().waitFor({ timeout: 10000 });
  check('a broadcast chat message from a participant is refused (chat: host only)', true);
  await guest.page.getByTestId('more').click().catch(() => undefined);
  await guest.page.keyboard.press('Escape');
  await guest.page.getByTestId('people-toggle').click();
  await guest.page.getByTestId('roster-rename').click();
  await guest.page.getByTestId('rename-input').fill('Renamed Bob');
  await guest.page.getByTestId('rename-save').click();
  await host.page.getByTestId('people-toggle').click();
  await host.page.getByText('Renamed Bob').first().waitFor({ timeout: 15000 });
  check('renaming works through the server and everybody sees the new name', true);
  const reactRefused = await apiCall(guest.page, 'PUT', '/api/v1/me/settings', { reactions: true });
  check('reactions stay off for everybody while locked', reactRefused.status === 403);
  await host.page.getByTestId('leave').click();
  await host.page.getByTestId('end-for-all').click();
  await guest.page.waitForSelector('.home', { timeout: 30000 });

  // 4. organization rules
  await apiCall(admin.page, 'PUT', '/api/v1/admin/settings', { joinDisclaimer: { value: 'This meeting may be monitored.' } });
  await apiCall(host.page, 'PUT', '/api/v1/me/settings', { joinBeforeHost: true });
  const code2 = await newMeeting(host.page, `Notice ${Date.now()}`);
  await joinByCode(guest.page, code2);
  await guest.page.getByTestId('join-notice-text').waitFor({ timeout: 15000 });
  check('the join notice is shown before joining', (await guest.page.getByTestId('join-notice-text').innerText()) === 'This meeting may be monitored.');
  await guest.page.getByTestId('join-notice-accept').click();
  await guest.page.waitForSelector('.call', { timeout: 30000 });
  check('after accepting, the person joins', true);
  await guest.page.getByTestId('leave').click();
  await guest.page.getByTestId('leave-confirm').click().catch(() => undefined);
  await guest.page.waitForSelector('.home', { timeout: 30000 });
  await apiCall(admin.page, 'PUT', '/api/v1/admin/settings', { joinDisclaimer: null, countryRule: { value: 'block' }, countries: { value: ['XX'] } });
  const blocked = await apiCall(guest.page, 'POST', `/api/v1/meetings/${code2}/join`, {});
  check('a blocked country (unknown = XX here) cannot join', blocked.status === 403 && blocked.body?.code === 'country_blocked', JSON.stringify(blocked.body));
  const adminJoin = await apiCall(admin.page, 'POST', `/api/v1/meetings/${code2}/join`, {});
  check('organization admins are exempt from the country rule', adminJoin.status === 200, String(adminJoin.status));
  await apiCall(admin.page, 'PUT', '/api/v1/admin/settings', { countryRule: null, countries: null, reactions: null });

  // 5. cancel
  const code3 = await newMeeting(host.page, `Cancel ${Date.now()}`);
  const c = await apiCall(host.page, 'DELETE', `/api/v1/meetings/${code3}`);
  await joinByCode(guest.page, code3);
  await guest.page.waitForSelector('[role=alert]', { timeout: 10000 });
  check('a cancelled meeting cannot be joined', c.status === 200 && (await guest.page.locator('[role=alert]').first().innerText()).includes('This meeting was cancelled'));

  // 6. lobby email
  const code4 = await newMeeting(host.page, `Lobby ${Date.now()}`, { waitingRoom: true });
  await joinByCode(guest.page, code4);
  await guest.page.waitForSelector('[data-testid=waiting]', { timeout: 20000 });
  const hostEmail = `${a.username}@davrabox.local`;
  let mail = null;
  for (let i = 0; i < 20 && !mail; i++) {
    const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${hostEmail}"`)}`)).json().catch(() => ({}));
    mail = (list.messages ?? []).find((m) => /is waiting/.test(m.Subject)) ?? null;
    if (!mail) await new Promise((r) => setTimeout(r, 1000));
  }
  check('the host gets the lobby email', Boolean(mail), mail?.Subject ?? 'none');
} catch (e) {
  console.error(e);
  exit = 1;
} finally {
  if (admin) await apiCall(admin.page, 'PUT', '/api/v1/admin/settings', { joinDisclaimer: null, countryRule: null, countries: null, reactions: null }).catch(() => undefined);
  for (const u of people) await u.cleanup().catch(() => undefined);
  await browser.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(exit || failed ? 1 : 0);
