// End-to-end: sharing a file in the meeting chat. Real browsers, real MinIO and ClamAV behind the API.
// Upload, notification in the chat, download by another participant with identical bytes, virus rejection,
// blocked type, and a non-participant who knows the meeting code gets nothing.
import { chromium } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { BASE, createUser } from './kc.mjs';

const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};
const PASSWORD = process.env.DEMO_USER_PASSWORD;
if (!PASSWORD) throw new Error('DEMO_USER_PASSWORD is required (source scripts/devenv.sh)');
const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$' + 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
async function open(username, password) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', permissions: ['camera', 'microphone'], acceptDownloads: true });
  const page = await ctx.newPage();
  await page.goto(BASE + '/app');
  await page.getByRole('button', { name: /Sign in|Kirish|Войти/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  return { ctx, page };
}
const joinByCode = async (page, code, pass) => {
  const form = page.locator('[data-testid=join-form]');
  await form.locator('input[inputmode=numeric]').fill(code);
  if (pass) {
    await form.locator('[data-testid=join-passcode-toggle]').check(); // the passcode field is hidden until asked for
    await form.locator('input[type=password]').fill(pass);
  }
  await form.getByRole('button').click();
};

const b = await createUser();
const stranger = await createUser();
let exit = 0;
try {
  const host = await open('user.demo', PASSWORD);
  if (process.env.E2E_DEBUG) { host.page.on('response', (r) => { if (r.status() >= 400) console.log('host HTTP', r.status(), r.url().slice(0, 110)); }); host.page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log('host console', m.type(), m.text().slice(0, 160)); }); }
  const pb = await open(b.username, b.password);
  const ps = await open(stranger.username, stranger.password);

  const title = `Files ${Date.now()}`;
  await host.page.getByTestId('new-meeting').click();
  await host.page.fill('[data-testid=meeting-title]', title);
  await host.page.locator('input[type=password][minlength]').fill('files-pass-1');
  await host.page.getByTestId('waiting-room').uncheck();
  await host.page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await host.page.waitForSelector(`li:has-text("${title}")`);
  const code = (await host.page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  await joinByCode(host.page, code);
  await host.page.waitForSelector('.call', { timeout: 30000 });
  await joinByCode(pb.page, code, 'files-pass-1');
  await pb.page.waitForSelector('.call', { timeout: 30000 });
  await host.page.waitForFunction(() => document.querySelectorAll('.grid .tile[data-identity]').length >= 2, null, { timeout: 40000 });
  await host.page.getByTestId('chat-toggle').click();
  await pb.page.getByTestId('chat-toggle').click();

  // 1. upload by the host, download by B with identical bytes
  const content = randomBytes(40_000);
  await host.page.getByTestId('file-input').setInputFiles({ name: 'budget plan.bin', mimeType: 'application/octet-stream', buffer: content });
  await pb.page.waitForSelector('[data-testid=file-chip]', { timeout: 30000 });
  check('the file shows up in the other participant\'s chat as a download chip', (await pb.page.getByTestId('file-chip').innerText()).includes('budget plan.bin'));
  const [download] = await Promise.all([pb.page.waitForEvent('download', { timeout: 30000 }), pb.page.getByTestId('file-chip').click()]);
  const path = await download.path();
  const { readFileSync } = await import('node:fs');
  const got = readFileSync(path);
  check('the downloaded bytes are identical (sha-256 match)', createHash('sha256').update(got).digest('hex') === createHash('sha256').update(content).digest('hex'));
  check('the browser saves it under the original name', download.suggestedFilename() === 'budget plan.bin');

  // 2. virus rejected, nothing appears for the others
  host.page.on('response', async (r) => { if (process.env.E2E_DEBUG && r.url().includes('/files?name=')) console.log('upload response', r.status(), await r.text().catch(() => '')); });
  if (process.env.E2E_DEBUG) console.log('errors before virus upload:', JSON.stringify(await host.page.locator('.error').allInnerTexts()));
  const before = await pb.page.getByTestId('file-chip').count();
  await host.page.getByTestId('file-input').setInputFiles({ name: 'invoice.txt', mimeType: 'text/plain', buffer: EICAR });
  await host.page.waitForSelector('.error', { timeout: 30000 });
  if (process.env.E2E_DEBUG) console.log('errors on page:', JSON.stringify(await host.page.locator('.error').allInnerTexts()));
  const err = await host.page.locator('.error').first().innerText();
  await pb.page.waitForTimeout(1500);
  check('a file with a virus is rejected with a clear message and is not announced', /antivirus|антивирус/i.test(err) && (await pb.page.getByTestId('file-chip').count()) === before, err);

  // 3. blocked type (the earlier error banner is replaced by the new one)
  await host.page.getByTestId('file-input').setInputFiles({ name: 'setup.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ-not-really') });
  await host.page.waitForFunction(() => /not allowed|запрещ|ruxsat yo/i.test(document.querySelector('.error')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => undefined);
  check('an executable file type is refused', /not allowed|запрещ|ruxsat yo/i.test(await host.page.locator('.error').first().innerText()));

  // 4. a user who knows the code but never entered gets nothing (checked through the API with their own token)
  const token = await ps.page.evaluate(() => {
    for (const k of Object.keys(sessionStorage)) {
      if (k.startsWith('oidc.user:')) return JSON.parse(sessionStorage.getItem(k)).access_token;
    }
    return null;
  });
  const apiBase = BASE + '/api';
  const ups = await fetch(`${apiBase}/v1/meetings/${code}/files?name=x.txt`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' }, body: 'x' });
  check('someone who knows the code but never entered cannot upload (403)', ups.status === 403, `status ${ups.status}`);

  for (const x of [host, pb, ps]) await x.ctx.close();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  exit = 1;
} finally {
  await browser.close();
  await b.cleanup();
  await stranger.cleanup();
}
if (results.some((r) => !r)) exit = 1;
console.log(exit === 0 ? 'FILES E2E: ALL PASSED' : 'FILES E2E: FAILURES');
process.exit(exit);
