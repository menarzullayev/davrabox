// End-to-end: meeting recording with a real LiveKit + Egress + MinIO stack (the local stack, not LiveKit Cloud).
// The host starts a recording: every participant sees the consent badge and hears the live-region announcement, a participant
// who joins late sees the badge at once, a plain member has no record control. After stop the recording is listed, becomes
// ready (encrypted at rest by the API) and downloads as a playable MP4.
// Needs: dev stack with the `egress` service up, API with RECORDING_ENABLED=1 (scripts/devenv.sh sets it when LiveKit Cloud is off).
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const joinByCode = async (page, code) => {
  const form = page.locator('[data-testid=join-form]');
  await form.locator('input[inputmode=numeric]').fill(code);
  await form.getByRole('button').click();
  await page.waitForSelector('.call', { timeout: 30000 });
};
const badgeVisible = (page, timeout = 20000) =>
  page.waitForSelector('[data-testid=rec-badge]', { timeout }).then(() => true).catch(() => false);
const badgeGone = (page, timeout = 20000) =>
  page.waitForSelector('[data-testid=rec-badge]', { state: 'detached', timeout }).then(() => true).catch(() => false);

const member = await createUser();
const late = await createUser();
const dir = await mkdtemp(join(tmpdir(), 'davra-rec-e2e-'));
let exit = 0;
try {
  const host = await open('user.demo', PASSWORD);
  const mem = await open(member.username, member.password);
  const title = `Recording ${Date.now()}`;
  await host.page.getByTestId('new-meeting').click();
  await host.page.fill('[data-testid=meeting-title]', title);
  await host.page.getByTestId('waiting-room').uncheck();
  await host.page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await host.page.waitForSelector(`li:has-text("${title}")`);
  const code = (await host.page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  await joinByCode(host.page, code);
  await joinByCode(mem.page, code);
  await host.page.waitForFunction(() => document.querySelectorAll('.grid .tile[data-identity]').length >= 2, null, { timeout: 40000 });

  const hasRecord = await host.page.waitForSelector('[data-testid=record]', { timeout: 15000 }).then(() => true).catch(() => false);
  if (!hasRecord) {
    console.log('BLOCKED  the host has no record control: recording is not enabled on this stack (egress service, RECORDING_ENABLED, local LiveKit)');
    exit = 1;
  } else {
    check('a plain member has no record control', (await mem.page.getByTestId('record').count()) === 0);
    check('no consent badge before recording starts', (await host.page.getByTestId('rec-badge').count()) === 0 && (await mem.page.getByTestId('rec-badge').count()) === 0);

    await host.page.getByTestId('record').click();
    check('the badge appears for the host', await badgeVisible(host.page));
    check('the badge appears for the member', await badgeVisible(mem.page));
    const announced = await mem.page
      .waitForFunction(() => /recording/i.test(document.querySelector('[data-testid=rec-live]')?.textContent ?? ''), null, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check('the member hears the announcement (aria-live region)', announced);
    check('the live region is polite', (await mem.page.getByTestId('rec-live').getAttribute('aria-live')) === 'polite');

    const lt = await open(late.username, late.password);
    await joinByCode(lt.page, code);
    check('a participant who joins during the recording sees the badge', await badgeVisible(lt.page));
    check('and the late joiner has no record control', (await lt.page.getByTestId('record').count()) === 0);

    await host.page.waitForTimeout(10000); // record for 10 seconds
    await host.page.getByTestId('record').click();
    check('the badge disappears for the host after stop', await badgeGone(host.page));
    check('the badge disappears for the member after stop', await badgeGone(mem.page));
    check('the badge disappears for the late joiner after stop', await badgeGone(lt.page));
    await lt.ctx.close();

    // The recording is listed (More panel) and becomes ready after Egress finished and the API encrypted the file.
    // The list refreshes whenever the More panel opens: reopen it until the recording is ready (Egress upload + encryption).
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      await host.page.getByTestId('more').click();
      await host.page.waitForSelector('[data-testid=rec-item]', { timeout: 10000 }).catch(() => undefined);
      ready = (await host.page.getByTestId('rec-download').count()) > 0;
      if (!ready) {
        await host.page.keyboard.press('Escape');
        await host.page.waitForTimeout(4000);
      }
    }
    check('the recording is listed with a download once it is ready', ready);
    if (ready) {
      const [dl] = await Promise.all([host.page.waitForEvent('download', { timeout: 60000 }), host.page.getByTestId('rec-download').first().click()]);
      const file = join(dir, 'rec.mp4');
      await dl.saveAs(file);
      const bytes = await readFile(file);
      check('the downloaded recording is a real MP4 (decrypted, ftyp box)', bytes.length > 10_000 && bytes.subarray(4, 8).toString() === 'ftyp', `${bytes.length} bytes`);
      check('a plain member cannot download it', (await mem.page.getByTestId('rec-download').count()) === 0);
    }
    await mem.ctx.close();
    await host.ctx.close();
  }
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  exit = 1;
} finally {
  await browser.close();
  await member.cleanup();
  await late.cleanup();
  await rm(dir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(exit || (failed ? 1 : 0));
