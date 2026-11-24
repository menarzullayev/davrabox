// End-to-end: passkey (WebAuthn) as a second factor for a member, using Chromium's virtual authenticator
// (no hardware). The member registers a passkey through the required action, signs out, and the next login
// must be satisfied by the passkey alone (no authenticator-app code).
// Note: organization admins keep a mandatory authenticator-app (TOTP) factor; this Keycloak has no condition
// for "has a passkey", so passkey-or-TOTP for admins would need a custom authenticator.
import { chromium } from 'playwright-core';
import { BASE, createUser } from './kc.mjs';

const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};

const user = await createUser({ roles: ['member'], requiredActions: ['webauthn-register'] });
const browser = await chromium.launch({ channel: 'msedge' });
let code = 0;
try {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });

  const signIn = async () => {
    await page.goto(BASE + '/app');
    await page.getByRole('button', { name: /^(Sign in|Kirish|Войти)$/ }).click();
    await page.waitForSelector('#username');
    await page.fill('#username', user.username);
    await page.fill('#password', user.password);
    await page.click('#kc-login');
  };

  await signIn();
  await page.waitForSelector('#registerWebAuthn', { timeout: 30000 });
  check('member is asked to register a passkey', true);
  await page.click('#registerWebAuthn');
  // Some Keycloak versions ask for a label after the browser created the credential.
  await page.waitForSelector('.home, #authenticatorLabel, #kc-login', { timeout: 30000 });
  if ((await page.locator('.home').count()) === 0) {
    if (await page.locator('#authenticatorLabel').count()) await page.fill('#authenticatorLabel', 'e2e passkey');
    await page.click('#kc-login');
  }
  await page.waitForSelector('.home', { timeout: 30000 });
  const creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials;
  check('registering stores a credential in the (virtual) authenticator and signs in', creds.length === 1);

  await page.getByRole('button', { name: /Sign out|Chiqish|Выйти/ }).click();
  await ctx.clearCookies();
  await page.evaluate(() => sessionStorage.clear());
  await signIn();
  await page.waitForSelector('#kc-form-webauthn, #authenticateWebAuthnButton, #authn_select, .home, #otp, form', { timeout: 30000 });
  await page.waitForTimeout(2500);
  if (process.env.E2E_DEBUG) console.log(await page.evaluate(() => Array.from(document.querySelectorAll('[id],button,input,a')).map((e) => `${e.tagName}#${e.id}:${(e.innerText || e.value || '').slice(0, 30)}`).join(' | ')));
  const asksPasskey = (await page.locator('#authenticateWebAuthnButton').count()) > 0;
  const asksOtp = (await page.locator('#otp').count()) > 0;
  check('second login challenges with the passkey, not an authenticator-app code', asksPasskey && !asksOtp);
  if (asksPasskey) {
    await page.click('#authenticateWebAuthnButton');
    await page.waitForSelector('.home', { timeout: 30000 });
    check('the passkey completes the sign-in', true);
  }
  await ctx.close();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  for (const c of browser.contexts()) for (const pg of c.pages()) console.log('page:', pg.url().slice(0, 100), '|', (await pg.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300));
  code = 1;
} finally {
  await browser.close();
  await user.cleanup();
}
if (results.some((r) => !r)) code = 1;
console.log(code === 0 ? 'PASSKEY E2E: ALL PASSED' : 'PASSKEY E2E: FAILURES');
process.exit(code);
