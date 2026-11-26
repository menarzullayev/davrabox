// End-to-end: the in-call feature package with two real people (host + member) through the real UI and the real media server.
// Pin, spotlight, mute all, virtual background (image), low-light switch, picture-in-picture, polls (+CSV), Q&A (upvote,
// anonymous, moderation, CSV) and the whiteboard (view-only, drawing permission, sync, PNG export).
// Chromium runs with fake media devices: the fake camera is a green field, so an image background replaces the whole frame.
import { readFileSync } from 'node:fs';
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
const foreign = [];

async function open(username, password) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', permissions: ['camera', 'microphone'], acceptDownloads: true, viewport: { width: 1360, height: 860 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('skipPreJoin', '1');
    localStorage.removeItem('davra.camfx');
  });
  const page = await ctx.newPage();
  const origin = new URL(BASE).origin;
  page.on('request', (r) => {
    const u = r.url();
    if (/^https?:/.test(u) && !u.startsWith(origin)) foreign.push(u);
  });
  await page.goto(BASE + '/app');
  await page.getByRole('button', { name: /^(Sign in|Kirish|Войти)$/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  return { ctx, page };
}
const joinForm = (page) => page.locator('[data-testid=join-form]');
async function joinByCode(page, code) {
  await joinForm(page).locator('input[inputmode=numeric]').fill(code);
  await joinForm(page).getByRole('button').click();
}
/** Opens the More panel (idempotent) and waits for one of its controls. */
async function more(page, testId) {
  if (!(await page.getByTestId(testId).isVisible().catch(() => false))) await page.getByTestId('more').click();
  await page.getByTestId(testId).waitFor({ state: 'visible', timeout: 10000 });
}
const closeMore = (page) => page.keyboard.press('Escape');
/** Mean colour of a video element (local tile = first tile with an identity). */
const tileColour = (page, nth) =>
  page.evaluate((n) => {
    const v = document.querySelectorAll('.tile[data-identity] video')[n];
    if (!v || !v.videoWidth) return null;
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 36;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, 64, 36);
    const d = g.getImageData(0, 0, 64, 36).data;
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      gg += d[i + 1];
      b += d[i + 2];
    }
    const k = d.length / 4;
    return [Math.round(r / k), Math.round(gg / k), Math.round(b / k)];
  }, nth);
const until = (fn, timeout = 20000) => fn().then(() => true).catch(() => false);
const readDownload = async (page, click) => {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), click()]);
  return { name: dl.suggestedFilename(), text: readFileSync(await dl.path(), 'utf8') };
};

const b = await createUser();
let exit = 0;
try {
  const host = await open('user.demo', PASSWORD);
  const mem = await open(b.username, b.password);
  const title = `InCall ${Date.now()}`;
  await host.page.getByTestId('new-meeting').click();
  await host.page.fill('[data-testid=meeting-title]', title);
  await host.page.getByTestId('waiting-room').uncheck();
  await host.page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await host.page.waitForSelector(`li:has-text("${title}")`);
  const code = (await host.page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  await joinByCode(host.page, code);
  await host.page.waitForSelector('.call', { timeout: 30000 });
  await joinByCode(mem.page, code);
  await mem.page.waitForSelector('.call', { timeout: 30000 });
  for (const p of [host.page, mem.page]) {
    await p.waitForFunction(() => document.querySelectorAll('.grid .tile[data-identity]').length >= 2, null, { timeout: 40000 });
    await p.waitForFunction(() => Array.from(document.querySelectorAll('.tile[data-identity] video')).filter((v) => v.videoWidth > 0).length >= 2, null, { timeout: 40000 });
  }
  const hostId = await host.page.locator('.tile[data-identity]').first().getAttribute('data-identity');
  const memId = await mem.page.locator('.tile[data-identity]').first().getAttribute('data-identity');

  // ---- pin (local) ----------------------------------------------------------------------------------------------------
  const hostTileOnMem = mem.page.locator(`.tile[data-identity="${hostId}"]`);
  await hostTileOnMem.hover();
  await hostTileOnMem.getByTestId('pin-toggle').click();
  check('pin: the member pins the host; the tile is marked pinned and featured', await until(() => mem.page.waitForSelector(`.tile.featured.pinned[data-identity="${hostId}"]`, { timeout: 8000 })));
  check('pin is local: the host sees no pin mark', (await host.page.locator('[data-testid=tile-pinned]').count()) === 0);
  await hostTileOnMem.hover();
  await hostTileOnMem.getByTestId('pin-toggle').click();

  // ---- spotlight (server-set, everyone) --------------------------------------------------------------------------------
  const memTileOnHost = host.page.locator(`.tile[data-identity="${memId}"]`);
  await memTileOnHost.hover();
  await memTileOnHost.getByTestId('spotlight-toggle').click();
  check('spotlight: the host sees the member spotlighted', await until(() => host.page.waitForSelector(`.tile.spotlit[data-identity="${memId}"]`, { timeout: 10000 })));
  check('spotlight: the member sees themselves spotlighted (room metadata)', await until(() => mem.page.waitForSelector(`.tile.spotlit[data-identity="${memId}"]`, { timeout: 10000 })));
  check('the member has no spotlight control', (await mem.page.getByTestId('spotlight-toggle').count()) === 0);
  await memTileOnHost.hover();
  await memTileOnHost.getByTestId('spotlight-toggle').click();
  check('spotlight cleared for everyone', await until(() => mem.page.waitForFunction(() => !document.querySelector('.tile.spotlit'), null, { timeout: 10000 })));

  // ---- mute all ---------------------------------------------------------------------------------------------------------
  await host.page.waitForFunction((id) => !document.querySelector(`.tile[data-identity="${id}"]`)?.textContent.includes('🔇'), memId, { timeout: 20000 }).catch(() => undefined);
  await host.page.getByTestId('people-toggle').first().click();
  await host.page.getByTestId('mute-all').click();
  await host.page.getByTestId('mute-all-confirm').click();
  check('mute all: the member is muted', await until(() => mem.page.waitForFunction(() => document.querySelector('[data-testid=mic]')?.getAttribute('data-off') !== null || document.querySelector('.tile[data-identity]')?.textContent.includes('🔇'), null, { timeout: 15000 })));
  check('mute all: the host is not muted', !(await host.page.locator('.tile[data-identity]').first().locator('.label').innerText()).includes('🔇'));
  check('mute all: the member has no mute-all control', (await mem.page.getByTestId('mute-all').count()) === 0);
  await host.page.keyboard.press('Escape');

  // ---- virtual background ---------------------------------------------------------------------------------------------
  const before = await tileColour(host.page, 0);
  await more(host.page, 'bg-open');
  await host.page.getByTestId('bg-open').click();
  await host.page.getByTestId('bg-picker').waitFor({ state: 'visible' });
  await host.page.getByTestId('bg-option-mountains').click();
  await host.page.keyboard.press('Escape');
  const localOk = await until(() => host.page.waitForFunction(() => {
    const v = document.querySelectorAll('.tile[data-identity] video')[0];
    if (!v?.videoWidth) return false;
    const c = document.createElement('canvas');
    c.width = 32; c.height = 18;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, 32, 18);
    const d = g.getImageData(0, 0, 32, 18).data;
    let gg = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { gg += d[i + 1]; b += d[i + 2]; }
    return b > gg;
  }, null, { timeout: 30000 }));
  check('virtual background: the host’s own video shows the image (green field replaced)', localOk, `${before} -> ${await tileColour(host.page, 0)}`);
  const remoteOk = await until(() => mem.page.waitForFunction((id) => {
    const v = document.querySelector(`.tile[data-identity="${id}"] video`);
    if (!v?.videoWidth) return false;
    const c = document.createElement('canvas');
    c.width = 32; c.height = 18;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, 32, 18);
    const d = g.getImageData(0, 0, 32, 18).data;
    let gg = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { gg += d[i + 1]; b += d[i + 2]; }
    return b > gg;
  }, hostId, { timeout: 30000 }));
  check('virtual background: the member receives the processed video', remoteOk);
  check('virtual background: the choice is remembered on this device', (await host.page.evaluate(() => localStorage.getItem('davra.camfx'))) === JSON.stringify({ bg: 'img:mountains', lowLight: false }));
  await more(host.page, 'lowlight');
  await host.page.locator('label:has([data-testid=lowlight])').click();
  check('low-light switch turns on', (await host.page.getByTestId('lowlight').getAttribute('data-state')) === 'true');
  await host.page.locator('label:has([data-testid=lowlight])').click();
  await closeMore(host.page);
  await more(host.page, 'bg-open');
  await host.page.getByTestId('bg-open').click();
  await host.page.getByTestId('bg-option-none').click();
  await host.page.keyboard.press('Escape');
  check('virtual background off: the camera is green again', await until(() => host.page.waitForFunction(() => {
    const v = document.querySelectorAll('.tile[data-identity] video')[0];
    const c = document.createElement('canvas');
    c.width = 16; c.height = 9;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(v, 0, 0, 16, 9);
    const d = g.getImageData(0, 0, 16, 9).data;
    let gg = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { gg += d[i + 1]; b += d[i + 2]; }
    return gg > b;
  }, null, { timeout: 20000 })));

  // ---- picture-in-picture --------------------------------------------------------------------------------------------
  const pipKind = await host.page.evaluate(() => ('documentPictureInPicture' in window ? 'document' : document.pictureInPictureEnabled ? 'video' : 'none'));
  if (pipKind === 'document') {
    await more(host.page, 'pip');
    await host.page.getByTestId('pip').click();
    const opened = await until(() => host.page.waitForFunction(() => !!window.documentPictureInPicture.window?.document.querySelector('[data-testid=pip-window]'), null, { timeout: 10000 }));
    check('picture-in-picture: a small window with the call opens', opened);
    const pipVideo = await host.page.evaluate(() => new Promise((res) => setTimeout(() => res(window.documentPictureInPicture.window?.document.querySelector('[data-testid=pip-window] video')?.videoWidth ?? 0), 2500)));
    check('picture-in-picture: it shows the other person’s video', pipVideo > 0, `videoWidth ${pipVideo}`);
    await host.page.evaluate(() => window.documentPictureInPicture.window?.close());
  } else {
    check(`picture-in-picture: ${pipKind} mode only in this browser (document PiP not available headless)`, true);
  }

  // ---- polls ------------------------------------------------------------------------------------------------------------
  await more(host.page, 'polls-toggle');
  await host.page.getByTestId('polls-toggle').click();
  await host.page.getByTestId('poll-new').click();
  await host.page.getByTestId('poll-question').fill('Which day suits you?');
  const opts = host.page.getByTestId('poll-option');
  await opts.nth(0).fill('Monday');
  await opts.nth(1).fill('Friday');
  await host.page.getByTestId('poll-launch').click();
  check('poll: the member gets a notice for the new poll', await until(() => mem.page.waitForSelector('[data-testid=poll-notice]', { timeout: 10000 })));
  check('poll: the member cannot create polls', (await mem.page.getByTestId('poll-new').count()) === 0);
  await mem.page.getByTestId('poll-notice-open').click();
  await mem.page.getByTestId('poll-choice').nth(1).click();
  await mem.page.getByTestId('poll-vote').click();
  check('poll: the host sees one vote counted', await until(() => host.page.waitForFunction(() => document.querySelector('[data-testid=poll-voters]')?.textContent.includes('1'), null, { timeout: 10000 })));
  check('poll: the member sees the results after voting', await until(() => mem.page.waitForFunction(() => /1 · 100%/.test(document.querySelectorAll('[data-testid=poll-count]')[1]?.textContent ?? ''), null, { timeout: 10000 })));
  await host.page.getByTestId('poll-end').click();
  check('poll: ending it reaches the member', await until(() => mem.page.waitForFunction(() => !document.querySelector('[data-testid=poll][data-open]'), null, { timeout: 10000 })));
  const csv = await readDownload(host.page, () => host.page.getByTestId('polls-csv').click());
  check('poll CSV: the host downloads counts and named ballots', /Which day suits you\?/.test(csv.text) && /Friday,1,1/.test(csv.text) && /participant,choice/.test(csv.text) && /,Friday\r\n/.test(csv.text), csv.name);

  // ---- Q&A --------------------------------------------------------------------------------------------------------------
  await host.page.keyboard.press('Escape');
  await more(mem.page, 'qa-toggle');
  await mem.page.getByTestId('qa-toggle').click();
  check('Q&A: no anonymous option until the host allows it', (await mem.page.getByTestId('qa-anon').count()) === 0);
  await mem.page.getByTestId('qa-input').fill('Is the recording shared afterwards?');
  await mem.page.getByTestId('qa-send').click();
  await more(host.page, 'qa-toggle');
  check('Q&A: the More button shows the unseen question count', await until(() => host.page.getByTestId('qa-badge').waitFor({ state: 'visible', timeout: 10000 })));
  await host.page.getByTestId('qa-toggle').click();
  check('Q&A: the host sees the question with the member’s name', await until(() => host.page.waitForFunction(() => document.querySelector('[data-testid=qa-item]')?.textContent.includes('recording shared'), null, { timeout: 10000 })));
  await host.page.getByTestId('qa-upvote').first().click();
  check('Q&A: the upvote reaches the member', await until(() => mem.page.waitForFunction(() => document.querySelector('[data-testid=qa-votes]')?.textContent === '1', null, { timeout: 10000 })));
  await host.page.locator('label:has([data-testid=qa-anon-allow])').click();
  await mem.page.getByTestId('qa-anon').waitFor({ state: 'visible', timeout: 10000 });
  await mem.page.getByTestId('qa-input').fill('Can we get the slides?');
  await mem.page.locator('label:has([data-testid=qa-anon])').click();
  await mem.page.getByTestId('qa-send').click();
  check('Q&A: an anonymous question shows no name, also to the host', await until(() => host.page.waitForFunction(() => Array.from(document.querySelectorAll('[data-testid=qa-item]')).some((li) => li.textContent.includes('slides') && li.querySelector('[data-testid=qa-author]')?.textContent === 'Anonymous'), null, { timeout: 10000 })));
  const slides = host.page.locator('[data-testid=qa-item]', { hasText: 'slides' });
  await slides.getByTestId('qa-hide').click();
  check('Q&A: a hidden question disappears for the member', await until(() => mem.page.waitForFunction(() => !Array.from(document.querySelectorAll('[data-testid=qa-item]')).some((li) => li.textContent.includes('slides')), null, { timeout: 10000 })));
  await host.page.locator('[data-testid=qa-item]', { hasText: 'recording' }).getByTestId('qa-answered').click();
  check('Q&A: "answered" reaches the member', await until(() => mem.page.waitForSelector('[data-testid=qa-item][data-answered]', { timeout: 10000 })));
  const qcsv = await readDownload(host.page, () => host.page.getByTestId('qa-csv').click());
  check('Q&A CSV: questions, Anonymous label, upvotes, answered/hidden', /recording shared afterwards\?.*,1,true,false/.test(qcsv.text) && /Can we get the slides\?,Anonymous,0,false,true/.test(qcsv.text), qcsv.name);

  // ---- whiteboard -------------------------------------------------------------------------------------------------------
  await host.page.keyboard.press('Escape');
  await mem.page.keyboard.press('Escape');
  await more(host.page, 'board-toggle');
  await host.page.getByTestId('board-toggle').click();
  await host.page.getByTestId('board-canvas').locator('canvas').first().waitFor({ state: 'visible', timeout: 60000 });
  await more(mem.page, 'board-toggle');
  await mem.page.getByTestId('board-toggle').click();
  await mem.page.getByTestId('board-canvas').locator('canvas').first().waitFor({ state: 'visible', timeout: 60000 });
  check('whiteboard: the member is view-only by default', (await mem.page.getByTestId('board').getAttribute('data-can-draw')) === 'false');
  const draw = async (page, dx) => {
    const box = await page.getByTestId('board-canvas').boundingBox();
    await page.locator('label:has([data-testid=toolbar-rectangle])').click();
    // The middle of the canvas: clear of the toolbar (top) and the shape properties (left).
    const cx = box.x + box.width * 0.45 + dx;
    const cy = box.y + box.height * 0.45;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 120, cy + 80, { steps: 6 });
    await page.mouse.up();
  };
  await draw(host.page, 0);
  check('whiteboard: the host’s rectangle reaches the member', await until(() => mem.page.waitForFunction(() => window.__davraBoard?.count() === 1, null, { timeout: 15000 })));
  await host.page.getByTestId('board-allow').first().click();
  check('whiteboard: drawing permission reaches the member', await until(() => mem.page.waitForSelector('[data-testid=board][data-can-draw=true]', { timeout: 10000 })));
  await draw(mem.page, 160);
  check('whiteboard: the member’s drawing reaches the host', await until(() => host.page.waitForFunction(() => window.__davraBoard?.count() === 2, null, { timeout: 15000 })));
  const [dl] = await Promise.all([host.page.waitForEvent('download', { timeout: 20000 }), host.page.getByTestId('board-png').click()]);
  const pngHead = readFileSync(await dl.path()).subarray(0, 4).toString('hex');
  check('whiteboard: the host downloads a PNG', pngHead === '89504e47', dl.suggestedFilename());
  check('whiteboard: the member has no export controls', (await mem.page.getByTestId('board-png').count()) === 0);

  // The PC staging uses a hosted LiveKit (production self-hosts it on our origin): its signalling host is not a leak.
  const outside = foreign.filter((u) => !new URL(u).hostname.endsWith('.livekit.cloud'));
  check('no request left our own origin (fonts, model, backgrounds, whiteboard)', outside.length === 0, outside.slice(0, 3).join(' '));
} catch (e) {
  console.error(e);
  exit = 1;
} finally {
  await browser.close();
  await b.cleanup?.();
}
const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(exit || results.some((r) => !r) ? 1 : 0);
