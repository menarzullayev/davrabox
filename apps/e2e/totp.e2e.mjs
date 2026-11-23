// End-to-end: TOTP two-factor authentication through Keycloak.
// A fresh user is created through the admin API with the CONFIGURE_TOTP required action. The test
// enrols an authenticator (reading the shared secret from the setup page), logs out, logs in again
// and must be challenged for a one-time code; a wrong code must be refused.
import { chromium } from 'playwright-core';
import { createHmac, randomBytes } from 'node:crypto';

const BASE = process.env.E2E_BASE_URL ?? 'https://localhost:8443';
const KC = process.env.KEYCLOAK_ADMIN_URL ?? `http://${process.env.LAN_IP ?? '127.0.0.1'}:8180/auth`; // internal admin port
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('KEYCLOAK_ADMIN_PASSWORD is required (source scripts/devenv.sh)');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // local dev stack only: Caddy internal CA

function base32decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/[\s=]/g, '').toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
// RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as configured in the realm OTP policy.
function totp(secret, offsetSteps = 0) {
  const counter = Math.floor(Date.now() / 30000) + offsetSteps;
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};

async function adminToken() {
  const r = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: 'admin-cli', grant_type: 'password', username: 'admin', password: ADMIN_PASSWORD }),
  });
  return (await r.json()).access_token;
}

const username = `totp.${randomBytes(4).toString('hex')}`;
const password = `Pw-${randomBytes(9).toString('base64url')}`;
const tok = await adminToken();
const h = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
const create = await fetch(`${KC}/admin/realms/davrabox/users`, {
  method: 'POST',
  headers: h,
  body: JSON.stringify({
    username,
    email: `${username}@davrabox.local`,
    firstName: 'Totp',
    lastName: 'Demo',
    enabled: true,
    emailVerified: true,
    attributes: { org_slug: ['demo'] },
    requiredActions: ['CONFIGURE_TOTP'],
    credentials: [{ type: 'password', value: password, temporary: false }],
  }),
});
if (create.status !== 201) throw new Error(`user creation failed: ${create.status}`);
const id = create.headers.get('location').split('/').pop();
const role = await (await fetch(`${KC}/admin/realms/davrabox/roles/member`, { headers: h })).json();
await fetch(`${KC}/admin/realms/davrabox/users/${id}/role-mappings/realm`, { method: 'POST', headers: h, body: JSON.stringify([role]) });

const browser = await chromium.launch({ channel: 'msedge' });
let code = 0;
try {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' });
  const page = await ctx.newPage();
  const signIn = async () => {
    await page.goto(BASE + '/');
    await page.getByRole('button', { name: /Sign in|Kirish|Войти/ }).click();
    await page.waitForSelector('#username');
    await page.fill('#username', username);
    await page.fill('#password', password);
    await page.click('#kc-login');
  };

  await signIn();
  // Enrolment page: reveal the manual key, read it, and confirm with a valid code.
  await page.waitForSelector('#kc-totp-secret-key, a:has-text("Unable to scan")', { timeout: 20000 });
  if (await page.locator('a:has-text("Unable to scan")').count()) await page.click('a:has-text("Unable to scan")');
  const secret = (await page.locator('#kc-totp-secret-key').innerText()).trim();
  check('first login forces TOTP enrolment and shows a shared secret', secret.length >= 16);
  const enrolStep = Math.floor(Date.now() / 30000);
  await page.fill('#totp', totp(secret));
  await page.fill('#userLabel', 'e2e-authenticator');
  await page.click('#saveTOTPBtn');
  await page.waitForSelector('.home', { timeout: 30000 });
  check('valid code completes enrolment and signs in', true);

  // Sign out and sign in again: now the code is required.
  await page.getByRole('button', { name: /Sign out|Chiqish|Выйти/ }).click();
  await page.waitForSelector('button.primary', { timeout: 20000 }).catch(() => undefined);
  await ctx.clearCookies();
  await page.evaluate(() => sessionStorage.clear());
  await signIn();
  await page.waitForSelector('#otp', { timeout: 20000 });
  check('second login asks for a one-time code', true);
  await page.fill('#otp', '000000');
  await page.click('#kc-login');
  const wrongRefused = await page.waitForSelector('#input-error-otp-code, .kc-feedback-text, [class*=error]', { timeout: 10000 }).then(() => true).catch(() => false);
  check('a wrong code is refused', wrongRefused && (await page.locator('.home').count()) === 0);
  // Keycloak refuses to reuse the code accepted at enrolment, so wait for the next 30 s time step.
  while (Math.floor(Date.now() / 30000) === enrolStep) await new Promise((r) => setTimeout(r, 1000));
  await page.fill('#otp', totp(secret));
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  check('the correct code signs in', true);
  await ctx.close();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  for (const c of browser.contexts()) {
    for (const pg of c.pages()) {
      const text = await pg.locator('body').innerText().catch(() => '');
      console.log('page:', pg.url().slice(0, 100), '|', text.replace(/\s+/g, ' ').slice(0, 300));
    }
  }
  code = 1;
} finally {
  await browser.close();
  await fetch(`${KC}/admin/realms/davrabox/users/${id}`, { method: 'DELETE', headers: h });
}
if (results.some((r) => !r)) code = 1;
console.log(code === 0 ? 'TOTP E2E: ALL PASSED' : 'TOTP E2E: FAILURES');
process.exit(code);
