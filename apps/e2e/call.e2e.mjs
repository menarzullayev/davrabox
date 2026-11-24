// End-to-end: two real users sign in through Keycloak (PKCE), one creates a passcode-protected
// meeting, the other joins, and both must see each other's video. Runs against the local dev
// stack (https://localhost:8443). Chromium is started with fake media devices so no hardware is needed.
// The self-signed Caddy certificate is accepted ONLY for this local test browser.
import { chromium } from 'playwright-core';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createUser } from './kc.mjs';

const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8443';
const PASSWORD = process.env.DEMO_USER_PASSWORD;
if (!PASSWORD) throw new Error('DEMO_USER_PASSWORD is required (source scripts/devenv.sh)');

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const root = join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  const dir = readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().pop();
  const exe = join(root, dir, 'chrome-win64', 'chrome.exe');
  if (!existsSync(exe)) throw new Error(`chromium not found at ${exe}`);
  return exe;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

// Prefer the system Edge (Chromium) when CHROMIUM_PATH is not given: it needs no download.
const launchBase = process.env.CHROMIUM_PATH ? { executablePath: findChromium() } : { channel: 'msedge' };
const browser = await chromium.launch({
  ...launchBase,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

async function newUser(username, password = PASSWORD) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  if (process.env.E2E_DEBUG) page.on('response', (r) => { if (r.status() >= 400) console.log(`[${username}] HTTP ${r.status()} ${r.url().slice(0, 140)}`); });
  if (process.env.E2E_DEBUG) page.on('console', (m) => console.log(`[${username}] ${m.type()}: ${(m.text().length > 300 ? m.text().slice(0, 60) + ' … ' + m.text().slice(-220) : m.text())}`));
  await page.goto(BASE + '/app');
  await page.getByRole('button', { name: /^(Sign in|Kirish|Ð’Ð¾Ð¹Ñ‚Ð¸)$/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  return { ctx, page };
}

let exitCode = 0;
try {
  // Both participants are plain members: organization admins must pass 2FA (see admin2fa.e2e.mjs).
  const second = await createUser();
  const admin = await newUser('user.demo'); // acts as host
  check('host (member) signs in via Keycloak and reaches the app', true);
  const user = await newUser(second.username, second.password);
  check('second member signs in via Keycloak and reaches the app', true);

  const title = `E2E ${Date.now()}`;
  const meetingPass = 'e2e-pass-123';
  await admin.page.getByTestId('new-meeting').click();
  await admin.page.fill('[data-testid=meeting-title]', title);
  await admin.page.fill('input[type=password][minlength]', meetingPass);
  await admin.page.getByRole('button', { name: /Create|Yaratish|Ð¡Ð¾Ð·Ð´Ð°Ñ‚ÑŒ/ }).click();
  await admin.page.waitForSelector(`li:has-text("${title}")`);
  const code = (await admin.page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  check('meeting created with an 11-digit code', /^[1-9]\d{10}$/.test(code), code);

  // Host joins by code (no passcode needed for the host).
  await admin.page.fill('input[inputmode=numeric]', code);
  await admin.page.locator('[data-testid=join-form]').getByRole('button').click();
  await admin.page.waitForSelector('.call', { timeout: 20000 });

  // Wrong passcode is refused with a visible error, no call screen.
  await user.page.fill('input[inputmode=numeric]', code);
  // The passcode field is hidden until the "I have a passcode" checkbox is ticked (critic D-13).
  check('the join card hides the passcode field until asked', (await user.page.locator('[data-testid=join-form] input[type=password]').count()) === 0);
  await user.page.locator('[data-testid=join-passcode-toggle]').check();
  await user.page.locator('[data-testid=join-form]').locator('input[type=password]').fill('definitely-wrong');
  await user.page.locator('[data-testid=join-form]').getByRole('button').click();
  await user.page.waitForSelector('[role=alert]', { timeout: 10000 });
  check('wrong passcode is rejected and shown to the user', (await user.page.locator('.call').count()) === 0);

  // Correct passcode joins.
  await user.page.locator('[data-testid=join-form]').locator('input[type=password]').fill(meetingPass);
  await user.page.locator('[data-testid=join-form]').getByRole('button').click();
  // The waiting room is on by default: the member waits, the host admits from the call screen.
  await user.page.waitForSelector('[data-testid=waiting]', { timeout: 20000 });
  check('with the correct passcode the member lands in the waiting room, not in the call', (await user.page.locator('.call').count()) === 0);
  await admin.page.waitForSelector('[data-testid=join-request]', { timeout: 20000 });
  await admin.page.locator('[data-testid=join-request] button.primary').click();
  await user.page.waitForSelector('.call', { timeout: 30000 });
  check('after the host admits, the member joins the call', true);

  await admin.page.waitForTimeout(8000);
  if (process.env.E2E_DEBUG) for (const [w, p] of [['admin', admin.page], ['member', user.page]]) console.log(w, 'tiles=', await p.locator('.grid .tile').count(), 'err=', await p.locator('.error').allInnerTexts(), 'count=', await p.locator('[data-testid=count]').innerText());
  // Both sides must show two participants and a playing remote video.
  for (const [who, p] of [['admin', admin.page], ['member', user.page]]) {
    await p.waitForFunction(() => document.querySelectorAll('.grid .tile').length >= 2, null, { timeout: 30000 });
    const ok = await p
      .waitForFunction(
        () => Array.from(document.querySelectorAll('.grid .tile video')).filter((v) => v.videoWidth > 0 && !v.paused).length >= 2,
        null,
        { timeout: 30000 },
      )
      .then(() => true)
      .catch(() => false);
    check(`${who} sees two participants with live video`, ok);
  }
  const hostBadge = await admin.page.locator('.badge').count();
  const memberBadge = await user.page.locator('.badge').count();
  check('only the host has the host badge', hostBadge === 1 && memberBadge === 0);

  await admin.ctx.close();
  await user.ctx.close();
  await second.cleanup();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  exitCode = 1;
} finally {
  await browser.close();
}
if (results.some((r) => !r.ok)) exitCode = 1;
console.log(exitCode === 0 ? 'E2E: ALL PASSED' : 'E2E: FAILURES');
process.exit(exitCode);
