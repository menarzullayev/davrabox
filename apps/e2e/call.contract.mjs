// Call screen contract check. The call-related e2e files (call, hostcontrols, chat, noise, layout, blur, cohost, files,
// turn, desktop) depend on a set of data-testids, class names and DOM facts. This script
//   1. extracts every data-testid those files use and fails when one is not covered below (so a new e2e selector cannot
//      slip through unnoticed), and
//   2. renders the call lab (/lab/call, fake participants, same CallView as the real call) in the states the e2e files
//      need and asserts each contract: presence, text markers, counts per role, popover access paths.
// The real LiveKit media (video/audio elements) cannot be checked here; everything else is the same component.
//   LAB_URL=http://127.0.0.1:5193 node call.contract.mjs        (build with VITE_CALL_LAB=1, serve with vite preview)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { pickOptionIndex } from './pick.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const base = process.env.LAB_URL ?? 'http://127.0.0.1:5193';
const FILES = ['call', 'hostcontrols', 'chat', 'noise', 'layout', 'blur', 'cohost', 'files', 'turn', 'desktop'].map((n) => `${n}.e2e.mjs`);

// 1. selector extraction ------------------------------------------------------------------------------------------
const used = new Map();
for (const f of FILES) {
  const src = readFileSync(join(here, f), 'utf8');
  for (const m of src.matchAll(/getByTestId\(['"`]([^'"`]+)['"`]\)/g)) used.set(m[1], [...(used.get(m[1]) ?? []), f]);
  for (const m of src.matchAll(/\[data-testid=([^\]\s]+)\]/g)) used.set(m[1], [...(used.get(m[1]) ?? []), f]);
}
// Owned by the home / waiting screens (another agent), not by the call screen.
const HOME_OWNED = new Set(['waiting', 'waiting-room', 'relay-mode']);
// Covered by the checks in section 2.
const COVERED = new Set(['grid', 'count', 'role-badge', 'lock', 'cohost-toggle', 'chat-toggle', 'chat-input', 'chat-line', 'chat-lines', 'chat-target', 'chat-panel', 'attach', 'file-input', 'file-chip', 'hand', 'reaction', 'noise', 'blur', 'layout', 'join-request', 'reactions', 'more']);
const reactEmoji = (id) => /^react-/.test(id) || /^layout-/.test(id); // react-<emoji> and layout-<mode> are checked as families below

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${detail ? ' :: ' + detail : ''}`);
};

const unknown = [...used.keys()].filter((id) => !HOME_OWNED.has(id) && !COVERED.has(id) && !reactEmoji(id));
check(`every call test id used by the e2e files is covered (${used.size} distinct, ${[...used.keys()].filter((id) => HOME_OWNED.has(id)).length} owned by the home screens)`, unknown.length === 0, unknown.map((id) => `${id} (${used.get(id)?.join(',')})`).join('; '));

// 2. rendering ----------------------------------------------------------------------------------------------------
const browser = await chromium.launch({ channel: 'msedge', args: ['--autoplay-policy=no-user-gesture-required'] });
async function open(query, lang = 'en', width = 1280, height = 720) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  await ctx.addInitScript((l) => { localStorage.setItem('lang', l); localStorage.setItem('theme', 'dark'); }, lang);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/lab/call?ui=0&lang=${lang}&${query}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.call');
  return { ctx, page, errors };
}
const text = (page, sel) => page.locator(sel).first().innerText();
const count = (page, sel) => page.locator(sel).count();
const tid = (id) => `[data-testid="${id}"]`;
const YOU = /\((You|Siz|Вы)\)/;

{
  // Host with 4 people: Aziz speaking (centre), Dilnoza muted + co-host + hand, Jasur reacting.
  const { ctx, page, errors } = await open('n=4&speaker=1&role=host&hands=2&mute=2&cohost=2&react=3:%F0%9F%8E%89');
  check('.call root and the grid with data-layout exist', (await count(page, '.call')) === 1 && (await page.locator(tid('grid')).getAttribute('data-layout')) === 'davra');
  check('every participant has a .tile[data-identity] inside .grid, yourself first', (await count(page, '.grid .tile[data-identity]')) === 4 && YOU.test(await text(page, '.grid .tile[data-identity] .label')));
  check('count shows the number of participants', (await text(page, tid('count'))).trim() === '4');
  check('exactly one tile is .featured and it is not yourself', (await count(page, '.tile.featured')) === 1 && !YOU.test(await text(page, '.tile.featured .label')));
  const tile = (i) => page.locator('.tile[data-identity]').nth(i);
  check('a muted participant has 🔇 in the .label and in the tile text', (await tile(2).locator('.label').innerText()).includes('🔇') && (await tile(2).innerText()).includes('🔇'));
  check('an unmuted participant has no 🔇 anywhere in the tile', !(await tile(1).innerText()).includes('🔇'));
  check('a raised hand shows ✋ in the .label of that tile only', (await tile(2).locator('.label').innerText()).includes('✋') && (await count(page, '.tile[data-identity] .label:has-text("✋")')) === 1);
  check('a co-host shows the co-host marker in the .label', /★\s*(Co-host)/i.test(await tile(2).locator('.label').innerText()));
  check('a reaction is a [data-testid=reaction] whose text is exactly the emoji', (await page.locator(tid('reaction')).first().textContent()) === '🎉');
  check('the host badge: one .badge with data-testid=role-badge', (await count(page, '.badge')) === 1 && /Host/i.test(await text(page, tid('role-badge'))));
  check('the host has the lock toggle with aria-pressed', ['true', 'false'].includes(await page.locator(tid('lock')).getAttribute('aria-pressed')));
  check('the host sees one co-host toggle per remote tile', (await count(page, tid('cohost-toggle'))) === 3);
  check('Mute and Remove are buttons found by accessible name inside a remote tile', (await tile(1).getByRole('button', { name: /Mute/ }).count()) === 1 && (await tile(1).getByRole('button', { name: /Remove/ }).count()) === 1);
  check('the local tile has no host actions', (await tile(0).getByRole('button').count()) === 0);
  check('the control bar test ids exist: hand, chat-toggle, layout', (await count(page, tid('hand'))) === 1 && (await count(page, tid('chat-toggle'))) === 1 && (await count(page, tid('layout'))) === 1);
  check('the tile of a camera-on participant holds a <video> inside .tile', (await count(page, '.tile[data-identity] video')) >= 1);
  check('no page errors', errors.length === 0, errors.join('|'));
  // lock click flips aria-pressed (hostcontrols reads it)
  await page.locator(tid('lock')).click();
  check('clicking the lock toggles aria-pressed', (await page.locator(tid('lock')).getAttribute('aria-pressed')) === 'true');
  await ctx.close();
}
{
  // Chat drawer.
  const { ctx, page } = await open('n=3&panel=chat&unread=0');
  for (const id of ['chat-panel', 'chat-lines', 'chat-input', 'chat-target', 'attach', 'file-input', 'file-chip']) check(`chat: ${id} exists`, (await count(page, tid(id))) >= 1);
  check('chat lines keep .chat-text and a [data-testid=chat-line] per line', (await count(page, `${tid('chat-line')} .chat-text`)) >= 1 && (await count(page, tid('chat-line'))) === 5);
  const before = await count(page, tid('chat-line'));
  const markup = '<b>bold</b> <img src=x onerror=alert(1)>';
  await page.locator(tid('chat-input')).fill(markup);
  await page.locator(tid('chat-input')).press('Enter');
  check('Enter in the chat input sends a line whose text is literal (no markup parsed)', (await count(page, tid('chat-line'))) === before + 1 && (await page.locator(`${tid('chat-line')} .chat-text`).last().innerText()) === markup && (await count(page, `${tid('chat-lines')} b, ${tid('chat-lines')} img`)) === 0);
  await page.locator(tid('chat-input')).fill('   ');
  await page.locator(tid('chat-input')).press('Enter');
  check('whitespace-only input sends nothing', (await count(page, tid('chat-line'))) === before + 1);
  await pickOptionIndex(page, tid('chat-target'), 1);
  await page.locator(tid('chat-input')).fill('private note');
  await page.locator(tid('chat-input')).press('Enter');
  check('a private line carries the private tag text', /private/i.test(await page.locator(tid('chat-line')).last().innerText()));
  await ctx.close();
}
{
  const { ctx, page } = await open('n=3&unread=1');
  check('unread count is in the textContent of chat-toggle as "(1)"', (await page.locator(tid('chat-toggle')).textContent()).includes('(1)'));
  await ctx.close();
}
{
  // Waiting-room requests.
  const { ctx, page } = await open('n=3&requests=2');
  check('join requests: [data-testid=join-request] with an Admit button.primary and a Deny button:not(.primary)', (await count(page, tid('join-request'))) === 2 && (await count(page, `${tid('join-request')} button.primary`)) === 2 && (await count(page, `${tid('join-request')} button:not(.primary)`)) === 2);
  await page.locator(`${tid('join-request')} button.primary`).first().click();
  check('answering a request removes it', (await count(page, tid('join-request'))) === 1);
  await ctx.close();
}
{
  // Plain member: no manager controls, no badge.
  const { ctx, page } = await open('n=3&role=member&requests=2');
  check('a member has no lock, no role badge, no .badge, no co-host toggle, no requests', (await count(page, tid('lock'))) === 0 && (await count(page, tid('role-badge'))) === 0 && (await count(page, '.badge')) === 0 && (await count(page, tid('cohost-toggle'))) === 0 && (await count(page, tid('join-request'))) === 0);
  check('a member has no Mute or Remove buttons on tiles', (await count(page, '.tile[data-identity] .tile-actions')) === 0);
  await ctx.close();
}
{
  // Co-host: lock and badge, but no co-host toggle.
  const { ctx, page } = await open('n=3&role=cohost');
  check('a co-host has the lock and a co-host badge but cannot appoint co-hosts', (await count(page, tid('lock'))) === 1 && /co-host/i.test(await text(page, tid('role-badge'))) && (await count(page, tid('cohost-toggle'))) === 0 && (await tile0Actions(page)) > 0);
  await ctx.close();
}
async function tile0Actions(page) {
  return page.locator('.tile[data-identity]').nth(1).getByRole('button', { name: /Mute/ }).count();
}
{
  // View switch, More panel (noise, blur) and the reactions popover are reachable the way the e2e files do it.
  const { ctx, page } = await open('n=3&speaker=1');
  const grid = page.locator(tid('grid'));
  const pick = async (m) => {
    if (!(await page.locator(tid(`layout-${m}`)).isVisible())) await page.locator(tid('layout')).click();
    await page.locator(tid(`layout-${m}`)).click();
  };
  await pick('speaker');
  check('layout: speaker view sets data-layout=speaker with one featured tile in the main slot', (await grid.getAttribute('data-layout')) === 'speaker' && (await count(page, '.tile.featured[data-slot=main]')) === 1);
  await pick('gallery');
  check('layout: grid view sets data-layout=gallery and no tile is featured', (await grid.getAttribute('data-layout')) === 'gallery' && (await count(page, '.tile.featured')) === 0);
  await pick('davra');
  check('layout: Davra view sets data-layout=davra', (await grid.getAttribute('data-layout')) === 'davra');
  await page.keyboard.press('Escape');

  await page.locator(tid('more')).click();
  check('More panel holds noise and blur with data-state', (await page.locator(tid('noise')).getAttribute('data-state')) === 'true' && (await page.locator(tid('blur')).getAttribute('data-state')) === 'false');
  await page.locator(tid('noise')).click();
  check('clicking noise flips data-state', (await page.locator(tid('noise')).getAttribute('data-state')) === 'false');
  await page.locator(tid('blur')).click();
  check('clicking blur flips data-state', (await page.locator(tid('blur')).getAttribute('data-state')) === 'true');
  await page.keyboard.press('Escape');

  await page.locator(tid('reactions')).click();
  await page.locator(tid('react-🎉')).click();
  check('react-<emoji> sends a reaction that appears as [data-testid=reaction] on your tile', (await page.locator(`.tile[data-identity] ${tid('reaction')}`).first().textContent()) === '🎉');
  await ctx.close();
}
{
  const { ctx, page } = await open('n=2&error=1');
  check('an error is shown in an .error element', (await text(page, '.error')).length > 0);
  await ctx.close();
}
await browser.close();
console.log(failed === 0 ? 'CALL CONTRACT: ALL PASSED' : `CALL CONTRACT: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
