// End-to-end: two-factor authentication is mandatory for organization admins and only for them.
//  - a fresh org_admin (no required action set by hand) is forced to enrol an authenticator at first login;
//  - a plain member is NOT asked for a second factor.
import { chromium } from 'playwright-core';
import { createHmac } from 'node:crypto';
import { BASE, createUser } from './kc.mjs';

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

const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};

const admin = await createUser({ roles: ['org_admin', 'member'] });
const member = await createUser({ roles: ['member'] });
const browser = await chromium.launch({ channel: 'msedge' });
let code = 0;
async function login(username, password) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' });
  await ctx.addInitScript(() => localStorage.setItem('skipPreJoin', '1'));
  const page = await ctx.newPage();
  await page.goto(BASE + '/app');
  await page.getByRole('button', { name: /^(Sign in|Kirish|Войти)$/ }).click();
  await page.waitForSelector('#username');
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
  return { ctx, page };
}
try {
  const m = await login(member.username, member.password);
  await m.page.waitForSelector('.home, #kc-totp-secret-key, #otp', { timeout: 30000 });
  check('a plain member is not asked for a second factor', (await m.page.locator('.home').count()) === 1);
  await m.ctx.close();

  const a = await login(admin.username, admin.password);
  await a.page.waitForSelector('.home, #kc-totp-secret-key, a:has-text("Unable to scan"), #otp', { timeout: 30000 });
  const forced = (await a.page.locator('.home').count()) === 0 && ((await a.page.locator('#kc-totp-secret-key, a:has-text("Unable to scan")').count()) > 0);
  check('an org_admin is forced to enrol an authenticator at first login', forced);
  if (forced) {
    if (await a.page.locator('a:has-text("Unable to scan")').count()) await a.page.click('a:has-text("Unable to scan")');
    const secret = (await a.page.locator('#kc-totp-secret-key').innerText()).trim();
    await a.page.fill('#totp', totp(secret));
    await a.page.fill('#userLabel', 'e2e');
    await a.page.click('#saveTOTPBtn');
    await a.page.waitForSelector('.home', { timeout: 30000 });
    check('the admin signs in only after enrolling with a valid code', true);
  }
  await a.ctx.close();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  code = 1;
} finally {
  await browser.close();
  await admin.cleanup();
  await member.cleanup();
}
if (results.some((r) => !r)) code = 1;
console.log(code === 0 ? 'ADMIN 2FA E2E: ALL PASSED' : 'ADMIN 2FA E2E: FAILURES');
process.exit(code);
