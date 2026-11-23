// End-to-end: end-to-end encrypted meetings (real browsers, real LiveKit; run by the integrator on the real stack).
//
//  1. The host creates an E2EE meeting: the dialog shows a full link whose key sits after '#', the badge is shown.
//  2. A member opens that link (signs in on the way: the key must survive the redirect) and sees the host's video:
//     a pixel check proves real frames were decrypted (not black, not a flat colour, moving content).
//  3. A third context WITHOUT the key joins by code: it sees the explanatory gate, has no video element, and opened no
//     media connection. Then it pastes the full link into the gate and gets the video.
//  4. The key never appears in any request URL, header, body or WebSocket URL of any context, and not in the address bar.
//  5. Background blur still works with E2EE on (the processor runs before encoding): the member still receives live video
//     and the picture is measurably softer.
//  6. Recording is unavailable: the record control is soft-disabled and explains why.
//  7. Chat works through the encrypted data channel; file attach is not offered.
//  8. A normal meeting is unaffected (no badge, no gate).
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

/** Everything a context sends: URLs, headers, bodies, WebSocket URLs. Searched for the key at the end. */
const wire = [];
async function open(username, password, label, url = BASE + '/app') {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  const sockets = [];
  ctx.on('request', (req) => {
    // Playwright reports the fragment of a navigation in url(), but a browser never puts it on the wire: compare what is sent.
    wire.push({ label, kind: 'request', text: [req.url().split('#')[0], JSON.stringify(req.headers()), req.postData() ?? ''].join('\n') });
  });
  page.on('websocket', (ws) => {
    sockets.push(ws.url());
    wire.push({ label, kind: 'websocket', text: ws.url() });
  });
  await page.goto(url);
  await page.getByRole('button', { name: /Sign in|Kirish|Войти/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  return { ctx, page, sockets };
}
const joinByCode = async (page, text) => {
  const form = page.locator('[data-testid=join-form]');
  await form.locator('input[inputmode=numeric]').fill(text);
  await form.getByRole('button').click();
};
const waitCall = (page) => page.waitForSelector('.call', { timeout: 30000 });
/** True when a remote (unmuted) video element shows real, changing, non-black pixels. */
const remoteVideoAlive = (page) =>
  page.evaluate(async () => {
    const v = Array.from(document.querySelectorAll('.tile[data-identity] video')).find((x) => !x.muted);
    if (!v || v.videoWidth === 0 || v.paused) return { ok: false, why: 'no playing remote video' };
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 90;
    const g = c.getContext('2d', { willReadFrequently: true });
    const frames = [];
    for (let k = 0; k < 8; k++) {
      g.drawImage(v, 0, 0, 160, 90);
      frames.push(Array.from(g.getImageData(0, 0, 160, 90).data));
      await new Promise((r) => setTimeout(r, 150));
    }
    const mean = frames[0].reduce((a, b) => a + b, 0) / frames[0].length;
    const spread = new Set(frames[0].filter((_, i) => i % 4 !== 3)).size; // distinct channel values: a flat or black frame has very few
    let changed = false;
    for (let k = 1; k < frames.length && !changed; k++) for (let i = 0; i < frames[k].length; i += 97) if (Math.abs(frames[k][i] - frames[0][i]) > 12) changed = true;
    return { ok: mean > 8 && spread > 12 && changed, why: `mean=${mean.toFixed(1)} distinct=${spread} changed=${changed}` };
  });
const sharpness = (page) =>
  page.evaluate(async () => {
    const v = Array.from(document.querySelectorAll('.tile[data-identity] video')).find((x) => !x.muted);
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
      for (let i = 4; i < d.length; i += 4) if (Math.abs(d[i] - d[i - 4]) + Math.abs(d[i + 1] - d[i - 3]) + Math.abs(d[i + 2] - d[i - 2]) > 40) hard++;
      total += (hard / (d.length / 4)) * 1000;
      await new Promise((r) => setTimeout(r, 120));
    }
    return total / 6;
  });

const member = await createUser();
const stranger = await createUser();
let exit = 0;
let key = '';
try {
  // 1. The host creates an encrypted meeting.
  const host = await open('user.demo', PASSWORD, 'host');
  const title = `E2EE ${Date.now()}`;
  await host.page.getByTestId('new-meeting').click();
  await host.page.fill('[data-testid=meeting-title]', title);
  await host.page.getByTestId('waiting-room').uncheck();
  check('the E2EE switch is off by default', !(await host.page.getByTestId('e2ee-toggle').isChecked()));
  await host.page.locator('label:has([data-testid=e2ee-toggle])').click();
  await host.page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  const link = await host.page.locator('[data-testid=e2ee-link]').inputValue({ timeout: 15000 });
  const m = /^(https?:\/\/[^/]+)\/app\?join=(\d{11,12})#k=([A-Za-z0-9_-]{43})$/.exec(link);
  check('the host gets a full link with the key after #', !!m, link.replace(/#k=.*/, '#k=<hidden>'));
  const code = m?.[2] ?? '';
  key = m?.[3] ?? '';
  await host.page.getByTestId('e2ee-link-done').click();
  check('the list marks the meeting as encrypted', (await host.page.locator(`li:has-text("${title}")`).getByText(/Encrypted|Shifrlangan|Зашифрована/).count()) > 0);
  await joinByCode(host.page, code);
  await waitCall(host.page);
  check('the host sees the E2EE badge', (await host.page.getByTestId('e2ee-badge').count()) === 1);
  const announced = await host.page.waitForFunction(() => /encryption is on|shifrlash yoqilgan|шифрование включено/i.test(document.querySelector('[data-testid=e2ee-status]')?.textContent ?? ''), null, { timeout: 20000 }).then(() => true).catch(() => false);
  check('the encryption state is announced (aria-live) once confirmed', announced);
  check('the live region is polite', (await host.page.getByTestId('e2ee-status').getAttribute('aria-live')) === 'polite');
  check('the address bar does not keep the key', !host.page.url().includes(key));

  // 2. A member follows the link (signing in on the way).
  const mem = await open(member.username, member.password, 'member', link);
  // open() ends at .home after sign-in: the code must be pre-filled from the link and the key kept through the redirect.
  check('after sign-in the join field holds the code from the link', (await mem.page.locator('[data-testid=join-form] input[inputmode=numeric]').inputValue()).replace(/\D/g, '') === code);
  check('the address bar does not keep the key', !mem.page.url().includes(key));
  await mem.page.locator('[data-testid=join-form]').getByRole('button').click();
  await waitCall(mem.page);
  await mem.page.waitForFunction(() => document.querySelectorAll('.grid .tile[data-identity]').length >= 2, null, { timeout: 40000 });
  await mem.page.waitForFunction(() => Array.from(document.querySelectorAll('.tile[data-identity] video')).some((v) => !v.muted && v.videoWidth > 0), null, { timeout: 40000 });
  const alive = await remoteVideoAlive(mem.page);
  check('the member sees the host video: decrypted, not black or flat, and moving', alive.ok, alive.why);
  check('the member sees the E2EE badge', (await mem.page.getByTestId('e2ee-badge').count()) === 1);

  // 3. A context without the key sees the gate, not a call.
  const str = await open(stranger.username, stranger.password, 'stranger');
  await joinByCode(str.page, code); // by code only: no key
  await str.page.waitForSelector('[data-testid=e2ee-gate]', { timeout: 20000 });
  check('without the key the gate explains why', /encrypted/i.test((await str.page.getByRole('heading', { level: 1 }).innerText()).toString()) || (await str.page.getByTestId('e2ee-gate').innerText()).length > 40);
  await str.page.waitForTimeout(3000);
  check('no call screen, no video element and no media connection behind the gate', (await str.page.locator('.call').count()) === 0 && (await str.page.locator('video').count()) === 0 && !str.sockets.some((u) => /livekit|\/rtc/i.test(u)), str.sockets.join(','));
  check('the member still sees only two participants (the stranger never joined the room)', (await mem.page.locator('.grid .tile[data-identity]').count()) === 2);
  await str.page.getByTestId('e2ee-gate-input').fill('https://x.example/app?join=' + code + '#k=wrong');
  await str.page.getByTestId('e2ee-gate-submit').click();
  check('a link without a valid key is refused with an explanation', (await str.page.getByTestId('e2ee-gate').innerText()).length > 0 && (await str.page.getByTestId('e2ee-gate').count()) === 1);
  await str.page.getByTestId('e2ee-gate-input').fill(link);
  await str.page.getByTestId('e2ee-gate-submit').click();
  await str.page.waitForSelector('.call', { timeout: 30000 });
  await str.page.waitForFunction(() => Array.from(document.querySelectorAll('.tile[data-identity] video')).some((v) => !v.muted && v.videoWidth > 0), null, { timeout: 40000 });
  check('pasting the full link into the gate lets the person in and shows video', (await remoteVideoAlive(str.page)).ok);

  // 7. Chat over the encrypted data channel; no file attach.
  await host.page.getByTestId('chat-toggle').click();
  await mem.page.getByTestId('chat-toggle').click();
  check('file attach is not offered in an encrypted meeting and the reason is shown', (await host.page.getByTestId('attach').count()) === 0 && (await host.page.getByTestId('e2ee-nofiles').count()) === 1);
  await host.page.fill('[data-testid=chat-input]', 'secret hello');
  await host.page.keyboard.press('Enter');
  const got = await mem.page.waitForFunction(() => Array.from(document.querySelectorAll('[data-testid=chat-line]')).some((l) => l.textContent?.includes('secret hello')), null, { timeout: 20000 }).then(() => true).catch(() => false);
  check('chat reaches the other participant through the encrypted data channel', got);

  // 6. Recording is not available.
  await host.page.getByTestId('more').click();
  const rec = host.page.getByTestId('record');
  if ((await rec.count()) > 0) {
    check('the record control is soft-disabled with the E2EE reason', (await rec.getAttribute('aria-disabled')) === 'true' && (await host.page.getByTestId('rec-e2ee-note').count()) === 1);
  } else {
    check('the record control is absent (recording not configured on this stack)', true);
  }

  // 5. Background blur with E2EE on.
  const before = await sharpness(mem.page);
  if (!(await host.page.getByTestId('blur').isVisible())) await host.page.getByTestId('more').click();
  await host.page.locator('label:has([data-testid=blur])').click();
  const blurOn = await host.page.waitForFunction(() => document.querySelector('[data-testid=blur]')?.getAttribute('data-state') === 'true', null, { timeout: 60000 }).then(() => true).catch(() => false);
  check('the blur toggle turns on in an encrypted meeting', blurOn);
  await mem.page.waitForTimeout(4000);
  const alive2 = await remoteVideoAlive(mem.page);
  check('the member still receives live decrypted video while the host is blurred', alive2.ok, alive2.why);
  const after = await sharpness(mem.page);
  check('the received picture is measurably softer (the blur ran before encoding)', after < before * 0.9, `sharpness ${before.toFixed(2)} -> ${after.toFixed(2)}`);

  // 4. The key never crossed the wire.
  const leaks = wire.filter((w) => w.text.includes(key) || w.text.includes(encodeURIComponent(key)));
  check('no request URL, header, body or WebSocket URL of any context contained the key', leaks.length === 0, leaks.map((l) => `${l.label}:${l.kind}`).join(','));
  check('requests were observed at all (the check is not vacuous)', wire.length > 50, String(wire.length));

  await str.ctx.close();
  await mem.ctx.close();
  await host.ctx.close();

  // 8. A normal meeting is unaffected.
  const h2 = await open('user.demo', PASSWORD, 'host2');
  const plain = `Plain ${Date.now()}`;
  await h2.page.getByTestId('new-meeting').click();
  await h2.page.fill('[data-testid=meeting-title]', plain);
  await h2.page.getByTestId('waiting-room').uncheck();
  await h2.page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await h2.page.waitForSelector(`li:has-text("${plain}")`);
  check('a normal meeting shows no key dialog', (await h2.page.getByTestId('e2ee-link').count()) === 0);
  const pcode = (await h2.page.locator(`li:has-text("${plain}") .code`).innerText()).replace(/\D/g, '');
  await joinByCode(h2.page, pcode);
  await waitCall(h2.page);
  check('a normal meeting has no E2EE badge and no gate', (await h2.page.getByTestId('e2ee-badge').count()) === 0 && (await h2.page.getByTestId('e2ee-gate').count()) === 0);
  await h2.ctx.close();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  exit = 1;
} finally {
  await browser.close();
  await member.cleanup();
  await stranger.cleanup();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(exit || (failed ? 1 : 0));
