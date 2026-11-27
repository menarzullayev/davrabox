// End-to-end: the sign-up and onboarding package of 2026-11-27 in a real browser against the real stack (Caddy, web, API,
// Keycloak, Postgres) and the Mailpit mail catcher of the dev stack.
//  1. Sign-up with an EMPTY organisation name: the organisation is named after the person; the verification email arrives
//     at once (decision 2) and nothing waits for it: the person is in the application immediately.
//  2. Home: the "Get started" card lists five steps for the administrator; the device check, a first meeting and the
//     verification link (clicked from the real email) tick their steps; the card can be dismissed for good.
//  3. Password reset: "Forgot password?" on the sign-in page sends a branded email; its link sets a new password that works.
//  4. First sign-in through an external provider (Google/Microsoft are simulated by an account linked to a throw-away
//     identity provider, the same state Keycloak's first broker login leaves): the set-up screen opens the organisation.
//  5. The sign-in hero says "Secure. Simple. Under your control."
// Needs the dev stack (`. scripts/devenv.sh`), the realm prepared by scripts/keycloak-onboarding.mjs (KC_SMTP_HOST=mailpit)
// and Mailpit on MAILPIT_URL (default http://127.0.0.1:58025).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { BASE, KC, adminHeaders } from './kc.mjs';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://127.0.0.1:58025';
const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};

const tag = randomBytes(4).toString('hex');
const email = `e2e.onb.${tag}@onboarding-e2e.example.org`;
const password = `Pw-${randomBytes(9).toString('base64url')}-x`;
const newPassword = `Np-${randomBytes(9).toString('base64url')}-y`;
const person = `Dilnoza ${tag}`;
const socialEmail = `e2e.social.${tag}@onboarding-e2e.example.org`;
const socialPassword = `Sp-${randomBytes(9).toString('base64url')}-z`;
const idpAlias = `e2e-idp-${tag}`;
const slugs = new Set();

/** Waits for the newest Mailpit message to `to` whose subject matches; returns { id, subject, text, html }. */
async function mail(to, subject, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json();
    const m = (list.messages ?? []).find((x) => subject.test(x.Subject));
    if (m) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
      return { id: m.ID, subject: m.Subject, text: full.Text ?? '', html: full.HTML ?? '' };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
const linkIn = (text) => /https?:\/\/\S+action-token\S+/.exec(text)?.[0] ?? null;
const step = (page, id) => page.getByTestId(`gs-step-${id}`);
const isDone = async (page, id) => (await step(page, id).getAttribute('data-done')) !== null;

const browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
let exit = 0;
try {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();

  // 5. hero
  await page.goto(BASE + '/app');
  await page.getByTestId('signin').waitFor({ timeout: 20000 });
  check('the sign-in hero says "Secure. Simple. Under your control."', (await page.locator('h1').innerText()).replace(/\s+/g, ' ').trim() === 'Secure. Simple. Under your control.');

  // 1. sign-up without an organisation name
  await page.goto(BASE + '/app/signup');
  await page.getByTestId('su-name').fill(person);
  await page.getByTestId('su-email').fill(email);
  check('the organisation field suggests a name made from the person', (await page.getByTestId('su-org').getAttribute('placeholder')) === `${person}’s team`);
  await page.getByTestId('su-password').fill('short');
  await page.getByTestId('su-submit').click();
  check('the password rule appears only after a too-short password', await page.getByText('The password needs at least 12 characters.').isVisible());
  await page.getByTestId('su-password').fill(password);
  await page.getByTestId('su-submit').click();
  await page.waitForSelector('#username', { timeout: 60000 });
  await page.fill('#password', password);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  check('the new account is in the application at once, before any email is verified (decision 2)', new URL(page.url()).pathname === '/app');

  const h = await adminHeaders();
  const users = await (await fetch(`${KC}/admin/realms/davrabox/users?email=${encodeURIComponent(email)}&exact=true`, { headers: h })).json();
  const slug = users[0]?.attributes?.org_slug?.[0];
  if (slug) slugs.add(slug);
  const org = spawnSync('docker', ['exec', 'davra-postgres', 'psql', '-U', 'davra_admin', '-d', 'davra', '-tAc', `SELECT name FROM organizations WHERE slug = '${String(slug).replace(/[^a-z0-9-]/g, '')}'`], { encoding: 'utf8' }).stdout.trim();
  check('an empty organisation name means the suggested one', org === `${person}’s team`, org);

  const verify = await mail(email, /Confirm your email|emailingizni tasdiqlang|Подтвердите email/);
  check('the verification email arrived right after the sign-up', Boolean(verify), verify?.subject ?? 'none');
  check('the email is the branded DavraBox template with a button and a plain link', Boolean(verify && verify.html.includes('#087069') && linkIn(verify.text)));
  check('the email is in the language the person signed up in (English page -> English email)', verify?.subject === 'Confirm your email for DavraBox', verify?.subject);

  // 2. the Get started card
  await page.getByTestId('get-started').waitFor({ timeout: 15000 });
  const ids = await page.locator('[data-testid^="gs-step-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
  check('the administrator sees five steps in the agreed order', JSON.stringify(ids) === JSON.stringify(['gs-step-devices', 'gs-step-invite', 'gs-step-meeting', 'gs-step-guests', 'gs-step-email']), ids.join(','));
  check('nothing is done yet on a brand-new organisation', (await page.locator('[data-testid^="gs-step-"][data-done]').count()) === 0);

  await page.getByTestId('gs-action-devices').click();
  await page.getByTestId('prejoin').waitFor();
  check('the device check opens the camera preview in check mode', (await page.getByTestId('prejoin').getAttribute('data-mode')) === 'test');
  await page.waitForFunction(() => (document.querySelector('[data-testid=prejoin-video]')?.videoWidth ?? 0) > 0, null, { timeout: 15000 });
  await page.getByTestId('prejoin-join').click();
  await page.getByTestId('get-started').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid=gs-step-devices]')?.hasAttribute('data-done'), null, { timeout: 10000 });
  check('"Test camera and microphone" ticks itself', await isDone(page, 'devices'));

  await page.getByTestId('gs-action-meeting').click();
  await page.fill('[data-testid=meeting-title]', `First ${tag}`);
  await page.locator('button[form=hm-new-form][type=submit]').click();
  await page.waitForSelector(`li:has-text("First ${tag}")`, { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('[data-testid=gs-step-meeting]')?.hasAttribute('data-done'), null, { timeout: 10000 });
  check('"Open your first meeting" ticks itself after creating one', await isDone(page, 'meeting'));
  check('the invite and guest-policy steps lead to the administration sections', (await page.getByTestId('gs-action-invite').getAttribute('href')) === '/admin#users' && (await page.getByTestId('gs-action-guests').getAttribute('href')) === '/admin#policies');

  // The verification link from the real email, opened in the same browser: the address becomes verified.
  if (verify) {
    const vp = await ctx.newPage();
    await vp.goto(linkIn(verify.text));
    const proceed = vp.getByRole('link', { name: /proceed|davom|продолж/i });
    if (await proceed.count()) await proceed.first().click();
    await vp.waitForLoadState('networkidle').catch(() => undefined);
    await vp.close();
  }
  await page.reload();
  await page.getByTestId('get-started').waitFor({ timeout: 15000 });
  check('clicking the link in the email ticks "Verify your email"', await isDone(page, 'email'));
  check('the progress says 3 of 5', (await page.getByTestId('gs-progress').innerText()).trim() === '3 of 5 done');

  await page.getByTestId('gs-action-guests').click();
  await page.waitForURL(/\/admin#policies$/);
  await page.getByRole('button', { name: /Save|Saqlash|Сохранить/ }).first().waitFor({ timeout: 20000 });
  check('the guest-policy link opens the Policies section', (await page.locator('[aria-current="page"]').innerText()).includes('Policies'));
  await page.getByRole('button', { name: /Save|Saqlash|Сохранить/ }).first().click();
  await page.waitForTimeout(1500);
  await page.goto(BASE + '/app');
  await page.getByTestId('get-started').waitFor({ timeout: 15000 });
  check('saving the organisation policy ticks "Choose the guest policy"', await isDone(page, 'guests'));

  await page.getByTestId('gs-dismiss').click();
  await page.getByTestId('get-started').waitFor({ state: 'detached' });
  await page.reload();
  await page.waitForSelector('.home', { timeout: 15000 });
  await page.waitForTimeout(1500);
  check('a dismissed card stays gone after a reload', (await page.getByTestId('get-started').count()) === 0);
  check('a verified address gets no reminder', (await page.getByTestId('verify-reminder').count()) === 0);

  // 3. password reset through the email
  const rp = await (await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' })).newPage();
  await rp.goto(BASE + '/app');
  await rp.getByTestId('signin').waitFor();
  await rp.getByRole('button', { name: 'Sign in' }).first().click();
  await rp.waitForSelector('#username', { timeout: 20000 });
  const forgot = rp.locator('a[href*="reset-credentials"]');
  check('the sign-in page offers "Forgot password?"', (await forgot.count()) === 1);
  await forgot.click();
  await rp.fill('#username', email);
  await rp.locator('[type=submit]').first().click();
  await rp.waitForLoadState('domcontentloaded');
  const reset = await mail(email, /Reset your DavraBox password|parolini tiklash|Сброс пароля/);
  check('the password reset email arrived', Boolean(reset), reset?.subject ?? 'none');
  check('the reset email is in the account language too', reset?.subject === 'Reset your DavraBox password', reset?.subject);
  if (reset) {
    await rp.goto(linkIn(reset.text));
    await rp.waitForSelector('#password-new', { timeout: 20000 });
    await rp.fill('#password-new', newPassword);
    await rp.fill('#password-confirm', newPassword);
    await rp.locator('[type=submit]').first().click();
    await rp.waitForSelector('.home', { timeout: 30000 });
    check('the link sets a new password and signs the person in', new URL(rp.url()).pathname === '/app');
    const fresh = await (await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' })).newPage();
    await fresh.goto(BASE + '/app');
    await fresh.getByRole('button', { name: 'Sign in' }).first().click();
    await fresh.waitForSelector('#username');
    await fresh.fill('#username', email);
    await fresh.fill('#password', newPassword);
    await fresh.click('#kc-login');
    await fresh.waitForSelector('.home', { timeout: 30000 });
    check('the new password works for a fresh sign-in', true);
  }

  // 4. first sign-in through an external provider (simulated link) -> organisation set-up
  const ah = await adminHeaders();
  const idp = await fetch(`${KC}/admin/realms/davrabox/identity-provider/instances`, {
    method: 'POST',
    headers: ah,
    body: JSON.stringify({ alias: idpAlias, providerId: 'oidc', enabled: true, config: { clientId: 'x', clientSecret: 'y', authorizationUrl: 'https://idp.invalid/a', tokenUrl: 'https://idp.invalid/t', hideOnLogin: 'true' } }),
  });
  check('test identity provider created', idp.status === 201);
  const cu = await fetch(`${KC}/admin/realms/davrabox/users`, {
    method: 'POST',
    headers: ah,
    body: JSON.stringify({ username: socialEmail, email: socialEmail, firstName: 'Social', lastName: tag, enabled: true, emailVerified: true, credentials: [{ type: 'password', value: socialPassword, temporary: false }] }),
  });
  const socialId = cu.headers.get('location')?.split('/').pop();
  await fetch(`${KC}/admin/realms/davrabox/users/${socialId}/federated-identity/${idpAlias}`, { method: 'POST', headers: ah, body: JSON.stringify({ identityProvider: idpAlias, userId: `ext-${tag}`, userName: socialEmail }) });
  const sp = await (await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' })).newPage();
  await sp.goto(BASE + '/app');
  await sp.getByRole('button', { name: 'Sign in' }).first().click();
  await sp.waitForSelector('#username');
  await sp.fill('#username', socialEmail);
  await sp.fill('#password', socialPassword);
  await sp.click('#kc-login');
  await sp.getByTestId('org-setup').waitFor({ timeout: 30000 });
  check('an account without an organisation gets the set-up screen (not a sign-in loop)', true);
  check('the set-up field is filled with the suggestion', (await sp.getByTestId('ob-org').inputValue()) === `Social ${tag}’s team`);
  await sp.getByTestId('ob-create').click();
  await sp.waitForSelector('.home', { timeout: 30000 });
  check('after "Create organisation" the person is the administrator of a new organisation', (await sp.getByTestId('admin-link').count()) === 1);
  const su = await (await fetch(`${KC}/admin/realms/davrabox/users/${socialId}`, { headers: ah })).json();
  const sslug = su.attributes?.org_slug?.[0];
  if (sslug) slugs.add(sslug);
  check('the account now carries the new organisation', Boolean(sslug), String(sslug));
  check('a provider-verified address gets the card without an open email step', (await sp.getByTestId('get-started').count()) === 1 && (await isDone(sp, 'email')));
} catch (e) {
  console.log('FAILED  unexpected error ::', e instanceof Error ? e.message : String(e));
  exit = 1;
} finally {
  try {
    const h = await adminHeaders();
    for (const addr of [email, socialEmail]) {
      const users = await (await fetch(`${KC}/admin/realms/davrabox/users?email=${encodeURIComponent(addr)}&exact=true`, { headers: h })).json();
      for (const u of users) await fetch(`${KC}/admin/realms/davrabox/users/${u.id}`, { method: 'DELETE', headers: h });
    }
    await fetch(`${KC}/admin/realms/davrabox/identity-provider/instances/${idpAlias}`, { method: 'DELETE', headers: h });
  } catch (e) {
    console.log('cleanup (Keycloak) failed:', e instanceof Error ? e.message : String(e));
  }
  for (const s of slugs) {
    if (!/^[a-z0-9-]+$/.test(s)) continue;
    const r = spawnSync('docker', ['exec', 'davra-postgres', 'psql', '-U', 'davra_admin', '-d', 'davra', '-v', 'ON_ERROR_STOP=1', '-c', `DELETE FROM organizations WHERE slug = '${s}'`], { encoding: 'utf8' });
    if (r.status !== 0) console.log('cleanup (organization) failed; remove it by hand:', s);
  }
  try {
    const list = await (await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent('to:"onboarding-e2e.example.org"')}`)).json();
    const ids = (list.messages ?? []).map((m) => m.ID);
    if (ids.length) await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ IDs: ids }) });
  } catch {
    /* the catcher is disposable */
  }
  await browser.close();
}
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} checks passed`);
process.exit(exit || (failed ? 1 : 0));
