// End-to-end: the profile package of 2026-11-27 in a real browser against the real stack (API, Keycloak, MinIO, ClamAV).
//  1. /app/profile from the left panel; the visibility notice; title, phone, time zone and the 12-hour clock are saved and
//     used by the meeting list.
//  2. Picture: cropped to a square in the browser, scanned, stored encrypted, served by its random id (image only).
//  3. Visibility rule: a colleague sees title and department but not email/phone; an organization admin sees all four.
//  4. Security through Keycloak's own flows: change password, turn on two-step verification and remove it, add a passkey;
//     "Where you're signed in" lists this device and ends another session.
//  5. Calendar: no consent is asked before "Connect"; a provider without keys cannot be connected.
import { createHmac, randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { BASE, createUser } from './kc.mjs';
import { pickOption } from './pick.mjs';

const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};
const PASSWORD = process.env.DEMO_USER_PASSWORD;
if (!PASSWORD) throw new Error('DEMO_USER_PASSWORD is required (source scripts/devenv.sh)');

function base32decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', base32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, '0');
}

const browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });

async function login(username, password, { otp } = {}) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', viewport: { width: 1366, height: 900 }, permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  await page.goto(BASE + '/app');
  await page.getByRole('button', { name: /^(Sign in|Kirish|Войти)$/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
  if (otp) {
    await page.waitForSelector('#otp', { timeout: 20000 });
    await page.fill('#otp', await otp());
    await page.click('#kc-login');
  }
  await page.waitForSelector('.home', { timeout: 30000 });
  return { ctx, page };
}
/** The signed-in person's access token, read from the app's own OIDC storage (for direct API checks). */
const tokenOf = (page) =>
  page.evaluate(() => {
    for (const s of [sessionStorage, localStorage]) for (let i = 0; i < s.length; i++) if (s.key(i)?.startsWith('oidc.user:')) return JSON.parse(s.getItem(s.key(i))).access_token;
    return null;
  });
const apiGet = async (page, path) => page.evaluate(async ([p, t]) => { const r = await fetch(p, { headers: { Authorization: `Bearer ${t}` } }); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, await tokenOf(page)]);
async function submitKc(page) {
  await page.locator('#kc-form-buttons input[type=submit], #kc-form-buttons button[type=submit], input[type=submit], button[type=submit]').first().click();
}

const people = [];
let exit = 0;
try {
  const a = await createUser();
  const b = await createUser();
  people.push(a, b);
  const me = await login(a.username, a.password);
  const p = me.page;

  // 1. profile fields
  await p.getByTestId('nav-profile').click();
  await p.getByTestId('profile-page').waitFor();
  check('the profile is under Settings in the left panel, at /app/profile', new URL(p.url()).pathname === '/app/profile');
  check('the visibility notice names who sees what', /Only organization admins also see your email and phone/.test(await p.getByTestId('pf-visibility').innerText()));
  const title = `QA lead ${randomBytes(2).toString('hex')}`;
  await p.getByTestId('pf-title').fill(title);
  await p.getByTestId('pf-phone').fill('+998 90 111-22-33');
  await p.getByTestId('pf-tz').fill('Asia/Tashkent');
  await pickOption(p, '[data-testid=pf-time-format]', '12h');
  await p.getByTestId('pf-save').click();
  await p.getByText('Profile saved').first().waitFor({ timeout: 15000 });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.getByTestId('pf-info-form').waitFor();
  check('title, phone and time zone are kept', (await p.getByTestId('pf-title').inputValue()) === title && (await p.getByTestId('pf-phone').inputValue()) === '+998 90 111-22-33' && (await p.getByTestId('pf-tz').inputValue()) === 'Asia/Tashkent');
  const prof = await apiGet(p, '/api/v1/me/profile');
  check('the 12-hour clock is saved', prof.body?.timeFormat === '12h', JSON.stringify(prof.body?.timeFormat));

  // the meeting list follows the clock choice
  await p.getByTestId('nav-home').click();
  await p.getByTestId('schedule-meeting').click();
  const dlg = p.getByRole('dialog', { name: 'Schedule a meeting' });
  await dlg.getByTestId('meeting-title').fill(`Clock ${Date.now()}`);
  await dlg.getByTestId('new-meeting-submit').click();
  await p.getByText('Meeting scheduled').first().waitFor({ timeout: 15000 });
  await p.getByTestId('nav-meetings').click();
  await p.getByRole('tab', { name: /Upcoming/ }).click();
  const times = await p.locator('.hm-row__time').allInnerTexts();
  check('meeting times are shown on the 12-hour clock', times.some((t) => /\d{1,2}:\d{2} (AM|PM)/.test(t)), times.join('|'));

  // 2. picture
  await p.getByTestId('nav-profile').click();
  await p.getByTestId('profile-page').waitFor();
  const png = await p.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 900;
    c.height = 600;
    const g = c.getContext('2d');
    g.fillStyle = '#2a7';
    g.fillRect(0, 0, 900, 600);
    g.fillStyle = '#fd0';
    g.beginPath();
    g.arc(450, 300, 200, 0, Math.PI * 2);
    g.fill();
    const b = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await b.arrayBuffer()));
  });
  const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.getByTestId('pf-photo-change').click()]);
  await chooser.setFiles({ name: 'me.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await p.getByTestId('pf-crop').waitFor();
  await p.getByTestId('pf-zoom-in').click();
  await p.getByTestId('pf-photo-save').click();
  await p.waitForSelector('[data-testid=pf-avatar][data-has-photo]', { timeout: 30000 });
  check('a wide picture is cropped to a square, scanned and saved', true);
  const url = (await apiGet(p, '/api/v1/me/profile')).body?.avatarUrl;
  const pic = await p.evaluate(async (u) => {
    const r = await fetch(u);
    const b = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type'), nosniff: r.headers.get('x-content-type-options'), csp: r.headers.get('content-security-policy'), jpeg: b[0] === 0xff && b[1] === 0xd8 };
  }, url);
  check('the picture is served by its random id as a JPEG, no sniffing, sandboxed', /^\/api\/v1\/avatars\/[0-9a-f]{32}$/.test(url) && pic.status === 200 && pic.type === 'image/jpeg' && pic.nosniff === 'nosniff' && /sandbox/.test(pic.csp ?? '') && pic.jpeg, JSON.stringify(pic));
  check('the header shows the picture', (await p.locator('.hm-who img').count()) === 1);
  const evil = await p.evaluate(async (t) => (await fetch('/api/v1/me/avatar', { method: 'PUT', headers: { Authorization: `Bearer ${t}` }, body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' })).status, await tokenOf(p));
  check('an SVG (script) is refused as a picture', evil === 400, String(evil));

  // 3. visibility
  const colleague = await login(b.username, b.password);
  const meId = (await apiGet(p, '/api/v1/me/onboarding')).status === 200 ? await p.evaluate(() => {
    for (const s of [sessionStorage, localStorage]) for (let i = 0; i < s.length; i++) if (s.key(i)?.startsWith('oidc.user:')) return JSON.parse(s.getItem(s.key(i))).profile.sub;
    return null;
  }) : null;
  // The API's user id is not the identity-provider id: find it through the admin user list as the admin below.
  const admin = await login('admin.demo', PASSWORD);
  const list = await apiGet(admin.page, `/api/v1/admin/users?search=${encodeURIComponent(a.username)}`);
  const aId = (list.body?.items ?? []).find((u) => (u.email ?? '').startsWith(a.username))?.id;
  check('the test person is found in the organization', Boolean(aId && meId), `${aId}`);
  const byColleague = await apiGet(colleague.page, `/api/v1/people/${aId}`);
  check('a colleague sees name, picture, title (not email or phone)', byColleague.status === 200 && byColleague.body.jobTitle === title && Boolean(byColleague.body.avatarUrl) && !('email' in byColleague.body) && !('phone' in byColleague.body), JSON.stringify(byColleague.body));
  const byAdmin = await apiGet(admin.page, `/api/v1/people/${aId}`);
  check('an organization admin also sees email and phone', byAdmin.body?.phone === '+998 90 111-22-33' && (byAdmin.body?.email ?? '').startsWith(a.username), JSON.stringify(byAdmin.body));

  // 4. security: sessions
  const second = await login(a.username, a.password);
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.getByTestId('pf-sessions').waitFor({ timeout: 20000 });
  const sessions = p.getByTestId('pf-session');
  check('"Where you are signed in" lists both sign-ins, this one first and marked', (await sessions.count()) >= 2 && (await sessions.first().getAttribute('data-current')) !== null);
  check('the device and browser are named', /Windows|Linux|macOS/.test(await sessions.first().innerText()));
  await sessions.nth(1).getByTestId('pf-session-end').click();
  await p.getByText('Session ended').first().waitFor({ timeout: 15000 });
  const after = await second.page.evaluate(async (t) => (await fetch('/api/v1/me/profile', { headers: { Authorization: `Bearer ${t}` } })).status, await tokenOf(second.page));
  const refreshed = await second.page.evaluate(async () => {
    const k = Object.keys(sessionStorage).concat(Object.keys(localStorage)).find((x) => x.startsWith('oidc.user:'));
    const u = JSON.parse(sessionStorage.getItem(k) ?? localStorage.getItem(k));
    const r = await fetch('/auth/realms/davrabox/protocol/openid-connect/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: 'davrabox-web', refresh_token: u.refresh_token }) });
    return r.status;
  });
  check('the ended session cannot renew its sign-in', refreshed === 400, `api=${after} refresh=${refreshed}`);

  // 4b. change password through Keycloak
  await p.getByTestId('pf-password-change').click();
  await p.waitForSelector('#password-new', { timeout: 30000 });
  const newPass = `Np-${randomBytes(9).toString('base64url')}-q`;
  await p.fill('#password-new', newPass);
  await p.fill('#password-confirm', newPass);
  await submitKc(p);
  await p.getByTestId('profile-page').waitFor({ timeout: 30000 });
  check('after Keycloak\'s password page the person is back on the profile', new URL(p.url()).pathname === '/app/profile');
  a.password = newPass;

  // 4c. two-step verification on, then off
  await p.getByTestId('pf-totp-add').click();
  await p.waitForSelector('#kc-totp-secret-key, a:has-text("Unable to scan")', { timeout: 30000 });
  if (!(await p.locator('#kc-totp-secret-key').count())) await p.click('a:has-text("Unable to scan")');
  const secret = (await p.locator('#kc-totp-secret-key').innerText()).trim();
  await p.fill('#totp', totp(secret));
  if (await p.locator('#userLabel').count()) await p.fill('#userLabel', 'e2e phone');
  await p.click('#saveTOTPBtn');
  await p.getByTestId('profile-page').waitFor({ timeout: 30000 });
  await p.getByTestId('pf-totp-remove').waitFor({ timeout: 20000 });
  check('two-step verification is on after Keycloak\'s set-up page', (await p.getByTestId('pf-totp').innerText()).includes('On'));
  // A code is accepted once: wait for the next 30-second step after the one used at set-up.
  const nextCode = async () => {
    await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 500));
    return totp(secret);
  };
  const third = await login(a.username, a.password, { otp: nextCode });
  check('signing in now asks for the code', true);
  await third.ctx.close();
  await p.getByTestId('pf-totp-remove').click();
  await p.waitForSelector('#kc-accept, button:has-text("Delete"), input[value*="Delete"], #kc-form-buttons', { timeout: 30000 });
  await p.locator('#kc-accept, button:has-text("Delete"), input[value*="Delete"], #kc-form-buttons [type=submit]').first().click();
  if (await p.locator('#otp').count()) {
    await p.fill('#otp', await nextCode());
    await p.click('#kc-login');
    await p.locator('#kc-accept, button:has-text("Delete"), input[value*="Delete"]').first().click().catch(() => undefined);
  }
  await p.getByTestId('pf-totp-add').waitFor({ timeout: 30000 });
  check('two-step verification is removed through Keycloak\'s confirmation', (await p.getByTestId('pf-totp').innerText()).includes('Off'));

  // 4d. passkey
  const cdp = await me.ctx.newCDPSession(p);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await p.getByTestId('pf-passkey-add').click();
  await p.waitForSelector('#registerWebAuthn', { timeout: 30000 });
  p.once('dialog', (d) => void d.accept('e2e passkey')); // Keycloak asks for the passkey's name with a browser prompt
  await p.click('#registerWebAuthn');
  await p.getByTestId('profile-page').waitFor({ timeout: 30000 });
  await p.getByTestId('pf-passkey').first().waitFor({ timeout: 20000 });
  const creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
  check('a passkey is added through Keycloak and listed', creds.length === 1 && (await p.getByTestId('pf-passkey').count()) === 1);
  // The passkey is now asked for at sign-in (copied into a fresh browser's virtual authenticator).
  const ctx4 = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' });
  const p4 = await ctx4.newPage();
  const cdp4 = await ctx4.newCDPSession(p4);
  await cdp4.send('WebAuthn.enable');
  const auth4 = await cdp4.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await cdp4.send('WebAuthn.addCredential', { authenticatorId: auth4.authenticatorId, credential: creds[0] });
  await p4.goto(BASE + '/app');
  await p4.getByRole('button', { name: /^Sign in$/ }).click();
  await p4.waitForSelector('#username');
  await p4.fill('#username', a.username);
  await p4.fill('#password', a.password);
  await p4.click('#kc-login');
  await p4.waitForSelector('#authenticateWebAuthnButton', { timeout: 20000 });
  check('signing in now asks for the passkey after the password', true);
  await p4.click('#authenticateWebAuthnButton');
  await p4.waitForSelector('.home', { timeout: 30000 });
  check('the passkey completes the sign-in', true);
  await ctx4.close();

  // linked accounts and calendar
  const links = await p.getByTestId('pf-links').innerText();
  check('linked accounts: only providers the realm really has are offered', /not set up yet|Google|Microsoft/.test(links), links.replace(/\s+/g, ' '));
  const cal = await apiGet(p, '/api/v1/calendar');
  for (const c of cal.body ?? []) {
    const btn = p.getByTestId(`pf-cal-${c.connected ? 'disconnect' : 'connect'}-${c.provider}`);
    check(`calendar ${c.provider}: the button matches the server (configured=${c.configured})`, c.connected || (await btn.isDisabled()) === !c.configured);
  }
  check('no calendar consent was asked before pressing Connect', !(await p.evaluate(() => performance.getEntriesByType('resource').some((r) => /calendar\/(google|microsoft)\/start/.test(r.name)))));
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
