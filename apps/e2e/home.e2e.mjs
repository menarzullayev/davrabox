// End-to-end: the signed-in home package of 2026-11-27 in a real browser against the real stack (API, Keycloak, LiveKit).
//  1. Left panel (desktop) with the real sections; addresses change, Back works; phones get the bottom tab bar and "More".
//  2. Quick actions: New / Join / Schedule (the date-time form opens directly); a scheduled meeting shows under Upcoming.
//  3. Personal room: created once, fixed number; the host enters directly; a colleague waits (waiting room on by default);
//     "regenerate" gives a new number and the old one is "Meeting not found".
//  4. Recent activity: after a real call in the personal room ends, the run appears with its duration and head count.
//  5. "Test your devices": camera picture, microphone level, and the real media-server checks.
//  6. Recordings while recording is off says so; personal whiteboards are created on this device.
//  7. Admin console: its section list sits in the left panel, exactly once.
import { chromium } from 'playwright-core';
import { BASE, createUser } from './kc.mjs';

const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};
const PASSWORD = process.env.DEMO_USER_PASSWORD;
if (!PASSWORD) throw new Error('DEMO_USER_PASSWORD is required (source scripts/devenv.sh)');

const browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });

async function login(username, password, { viewport = { width: 1366, height: 900 }, path = '/app' } = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', viewport, permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] });
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
const digits = (s) => (s ?? '').replace(/\D/g, '');

const people = [];
let exit = 0;
try {
  const a = await createUser();
  const b = await createUser();
  people.push(a, b);
  const host = await login(a.username, a.password);
  const p = host.page;

  // 1. left panel and addresses
  const nav = p.getByRole('navigation', { name: 'Main menu' });
  const names = await nav.getByRole('link').allInnerTexts();
  check('the left panel lists Home, Meetings, Recordings, Whiteboards, Settings, Profile, Help (a member: no Admin)', names.join('|') === 'Home|Meetings|Recordings|Whiteboards|Settings|Profile|Help', names.join('|'));
  check('the phone tab bar is not shown on a desktop', !(await p.locator('.hm-tabbar').isVisible()));
  await p.getByTestId('nav-meetings').click();
  await p.getByTestId('meetings-page').waitFor();
  check('Meetings has its own address', new URL(p.url()).pathname === '/app/meetings');
  await p.goBack();
  await p.getByTestId('new-meeting').waitFor();
  check('Back returns to the home screen', new URL(p.url()).pathname === '/app');

  // 2. schedule
  const title = `Scheduled ${Date.now()}`;
  await p.getByTestId('schedule-meeting').click();
  const dlg = p.getByRole('dialog', { name: 'Schedule a meeting' });
  await dlg.waitFor();
  check('Schedule opens the form with the date and time first', await dlg.getByTestId('schedule-when').isVisible());
  await dlg.getByTestId('meeting-title').fill(title);
  await dlg.getByTestId('new-meeting-submit').click();
  await p.getByText('Meeting scheduled').first().waitFor({ timeout: 15000 });
  await p.getByTestId('nav-meetings').click();
  await p.getByRole('tab', { name: /Upcoming/ }).click();
  check('the scheduled meeting is listed under Upcoming', await p.getByText(title).first().isVisible({ timeout: 10000 }));
  await p.getByTestId('nav-home').click();

  // 3. personal room
  await p.getByTestId('pr-setup').click();
  await p.getByTestId('pr-code').waitFor({ timeout: 15000 });
  const code1 = digits(await p.getByTestId('pr-code').innerText());
  check('the personal room has a fixed 11-digit number', /^\d{11}$/.test(code1), code1);
  check('the waiting room is on by default', await p.getByText('Waiting room on').isVisible());
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.getByTestId('pr-code').waitFor({ timeout: 15000 });
  check('the number stays the same after a reload', digits(await p.getByTestId('pr-code').innerText()) === code1);

  const guest = await login(b.username, b.password);
  await guest.page.fill('input[inputmode=numeric]', code1);
  await guest.page.locator('[data-testid=join-form]').getByRole('button').click();
  await guest.page.waitForSelector('[data-testid=waiting]', { timeout: 20000 });
  check('a colleague waits in the lobby of the personal room', true);
  await guest.page.getByRole('button', { name: /Cancel|Leave|Bekor/ }).first().click().catch(() => undefined);

  // the host enters directly; a short real call makes a run for Recent activity
  await p.getByTestId('pr-start').click();
  await p.waitForSelector('.call', { timeout: 30000 });
  check('the host enters the own personal room directly', true);
  await p.waitForTimeout(20000); // two media-server polls with somebody connected
  await p.getByTestId('leave').click();
  await p.getByTestId('end-for-all').click(); // the host ends it for everyone: the run closes at once
  await p.waitForSelector('.home', { timeout: 20000 });

  // 4. Recent activity (the run closes once the room is gone or after the poll sees nobody; the room lingers up to its
  //    empty timeout, so wait for it)
  let item = null;
  for (let i = 0; i < 30 && !item; i++) {
    await p.goto(BASE + '/app', { waitUntil: 'domcontentloaded' });
    await p.getByTestId('recent-activity').waitFor({ timeout: 30000 });
    await p.waitForFunction(() => !document.querySelector('[data-testid=recent-activity][aria-busy]'), null, { timeout: 15000 });
    const rows = p.getByTestId('ra-item');
    if ((await rows.count()) > 0) item = rows.first();
    else await p.waitForTimeout(15000);
  }
  check('the ended call appears in Recent activity', Boolean(item));
  if (item) {
    const txt = await item.innerText();
    check('it shows a duration and the head count the server recorded', /min|under a minute/.test(txt) && /Participants: 1/.test(txt), txt.replace(/\s+/g, ' '));
    check('it is marked as the personal room', /Personal room/.test(txt));
  }

  // regenerate
  await p.getByTestId('pr-regenerate').click();
  await p.getByTestId('pr-regenerate-confirm').click();
  await p.waitForFunction((old) => (document.querySelector('[data-testid=pr-code]')?.textContent ?? '').replace(/\D/g, '') !== old, code1, { timeout: 15000 });
  const code2 = digits(await p.getByTestId('pr-code').innerText());
  check('regenerate gives a new number', /^\d{11}$/.test(code2) && code2 !== code1, `${code1} -> ${code2}`);
  await guest.page.goto(BASE + '/app');
  await guest.page.waitForSelector('.home');
  await guest.page.fill('input[inputmode=numeric]', code1);
  await guest.page.locator('[data-testid=join-form]').getByRole('button').click();
  await guest.page.waitForSelector('[role=alert]', { timeout: 10000 });
  check('the old number is "Meeting not found"', (await guest.page.locator('[role=alert]').first().innerText()).includes('Meeting not found'));

  // 5. Test your devices
  await p.getByTestId('nav-settings').click();
  await p.getByTestId('st-devices').click();
  await p.getByTestId('devices-page').waitFor();
  await p.waitForFunction(() => (document.querySelector('[data-testid=dv-video]')?.videoWidth ?? 0) > 0, null, { timeout: 15000 });
  check('the camera picture is shown', true);
  await p.waitForSelector('[data-testid=dv-level][data-heard]', { timeout: 15000 }).then(
    () => check('the microphone level moves (fake microphone tone)', true),
    () => check('the microphone level moves (fake microphone tone)', false),
  );
  await p.getByTestId('dv-net-run').click();
  await p.getByTestId('dv-net-summary').waitFor({ timeout: 120000 });
  const res = {};
  for (const id of ['ws', 'rtc', 'turn', 'proto', 'audio', 'video']) res[id] = await p.getByTestId(`dv-check-${id}`).getAttribute('data-result');
  check('the real media-server checks ran: signalling and WebRTC connect', res.ws === 'pass' && ['pass', 'warn'].includes(res.rtc), JSON.stringify(res));
  check('publishing audio and video works', ['pass', 'warn'].includes(res.audio) && ['pass', 'warn'].includes(res.video), JSON.stringify(res));

  // 6. Recordings and whiteboards
  await p.getByTestId('nav-recordings').click();
  await p.getByTestId('recordings-page').waitFor();
  await p.waitForSelector('[data-testid=rc-off], [data-testid=rc-empty], [data-testid=rc-item]', { timeout: 15000 }).catch(() => undefined);
  const recOff = await p.getByTestId('rc-off').isVisible().catch(() => false);
  const recEmpty = await p.getByTestId('rc-empty').isVisible().catch(() => false);
  check('Recordings tells whether recording is on (off: a notice; on: the list or "no recordings")', recOff || recEmpty || (await p.getByTestId('rc-item').count()) > 0);
  await p.getByTestId('nav-whiteboards').click();
  await p.getByTestId('bd-new').click();
  await p.getByTestId('bd-name').fill('E2E board');
  await p.getByTestId('bd-name-save').click();
  await p.getByTestId('pb-canvas').waitFor({ timeout: 30000 });
  await p.getByTestId('pb-back').click();
  check('a personal whiteboard is created and listed (this device only)', (await p.getByTestId('bd-item').count()) === 1);

  // 1b. phone layout
  const phone = await login(b.username, b.password, { viewport: { width: 390, height: 844 } });
  check('phones get the bottom tab bar instead of the panel', (await phone.page.locator('.hm-tabbar').isVisible()) && !(await phone.page.locator('.sh-panel').isVisible()));
  await phone.page.getByTestId('tab-more').click();
  await phone.page.getByTestId('more-sheet').waitFor();
  await phone.page.getByTestId('more-whiteboards').click();
  await phone.page.getByTestId('whiteboards-page').waitFor();
  check('"More" leads to the other sections', new URL(phone.page.url()).pathname === '/app/whiteboards');
  const overflow = await phone.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('nothing sticks out sideways on a phone', overflow <= 1, `${overflow}px`);

  // 7. admin console inside the shell
  const admin = await login('admin.demo', PASSWORD, { path: '/admin' });
  await admin.page.waitForSelector('.sh-panel .adm-nav', { timeout: 20000 });
  check('the admin sections are in the left panel, once', (await admin.page.locator('.adm-nav').count()) === 1 && (await admin.page.locator('.sh-panel .adm-nav button').count()) >= 8);
  await admin.page.locator('.adm-nav button', { hasText: /Polic/ }).click();
  check('choosing a section keeps its address', new URL(admin.page.url()).hash === '#policies');
  await admin.page.getByTestId('nav-home').click();
  await admin.page.getByTestId('new-meeting').waitFor();
  check('from the admin console the panel leads back home without a reload', new URL(admin.page.url()).pathname === '/app');
} catch (e) {
  console.error(e);
  exit = 1;
} finally {
  for (const u of people) await u.cleanup().catch(() => undefined);
  await browser.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(exit || failed ? 1 : 0);
