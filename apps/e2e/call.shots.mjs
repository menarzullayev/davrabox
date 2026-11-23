// Screenshots of the call screen lab for the design evidence (docs/design/screenshots/wave1-call/), each <= 250 KB.
//   LAB_URL=http://127.0.0.1:5193 node call.shots.mjs            all shots
//   LAB_URL=... node call.shots.mjs quick                         a few, into $SG_OUT (default: current dir)
// Needs `VITE_CALL_LAB=1 pnpm build` and `pnpm exec vite preview --port 5193 --strictPort` in apps/web.
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const base = process.env.LAB_URL ?? 'http://127.0.0.1:5193';
const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.SG_OUT ?? join(here, '..', '..', 'docs', 'design', 'screenshots', 'wave1-call');
mkdirSync(out, { recursive: true });
const quick = process.argv[2] === 'quick';
const MAX = 250 * 1024;

const browser = await chromium.launch({ channel: 'msedge', args: ['--autoplay-policy=no-user-gesture-required'] });
const tid = (id) => `[data-testid="${id}"]`;

/** name, query, {theme, lang, w, h}, optional action(page), optional motion */
const D = { theme: 'dark', lang: 'uz', w: 1280, h: 720 };
const SHOTS = [
  ['davra-n2', 'n=2&speaker=1', D],
  ['davra-n5', 'n=5&speaker=2&hands=3', D],
  ['davra-n8', 'n=8&speaker=3&hands=2&mute=4&cohost=5', D],
  ['davra-n12', 'n=12&speaker=5&hands=2,7&mute=3,9&camoff=4,10', D],
  ['davra-n13-auto-grid-hint', 'n=13&speaker=4', D],
  ['speaker-view', 'n=7&mode=speaker&speaker=3&hands=2', D],
  ['grid-view', 'n=9&mode=gallery&speaker=2', D],
  ['screen-share-davra', 'n=6&share=1&speaker=2', D],
  ['screen-share-speaker', 'n=6&mode=speaker&share=1&speaker=2', D],
  ['hand-raised', 'n=6&speaker=1&hands=2,4', D],
  ['reactions-bloom', 'n=6&speaker=1&react=3:%F0%9F%8E%89', D, async (p) => { await p.waitForTimeout(0); }, 'no-preference', 420],
  ['chat-drawer', 'n=5&speaker=2&panel=chat', D],
  ['host-panel-requests', 'n=6&speaker=2&panel=people&requests=2&hands=3&cohost=2&mute=4', { ...D, lang: 'en' }],
  ['member-view', 'n=6&speaker=2&role=member', { ...D, lang: 'en' }],
  ['menu-reactions', 'n=6&speaker=2', { ...D, lang: 'en' }, async (p) => { await p.locator(tid('reactions')).click(); await p.waitForTimeout(250); }],
  ['menu-layout', 'n=6&speaker=2', { ...D, lang: 'en' }, async (p) => { await p.locator(tid('layout')).click(); await p.waitForTimeout(250); }],
  ['menu-more', 'n=6&speaker=2&relay=1', { ...D, lang: 'en' }, async (p) => { await p.locator(tid('more')).click(); await p.waitForTimeout(250); }],
  ['connecting', 'connecting=1', D],
  ['error-and-reconnecting', 'n=4&speaker=1&error=1&reconnecting=1&quality=poor', D],
  ['keyboard-focus', 'n=6&speaker=2', { ...D, lang: 'en' }, async (p) => { await p.locator(tid('hand')).focus(); await p.keyboard.press('Shift+Tab'); await p.keyboard.press('Tab'); }],
  ['light-davra-n8', 'n=8&speaker=3&hands=2&mute=4', { ...D, theme: 'light', lang: 'en' }],
  ['light-chat', 'n=5&speaker=2&panel=chat', { ...D, theme: 'light', lang: 'en' }],
  ['ru-davra-n8', 'n=8&speaker=3&hands=2&mute=4&cohost=5', { ...D, lang: 'ru' }],
  ['tablet-768-davra-n8', 'n=8&speaker=3&hands=2', { ...D, w: 768, h: 1024 }],
  ['tablet-768-speaker', 'n=6&mode=speaker&speaker=3', { ...D, w: 768, h: 1024, lang: 'en' }],
  ['mobile-360-davra-n5', 'n=5&speaker=2&hands=1', { ...D, w: 360, h: 740 }],
  ['mobile-360-davra-n8-compact-ring', 'n=8&speaker=4&hands=2', { ...D, w: 360, h: 740, lang: 'en' }],
  ['mobile-360-n11-speaker-fallback', 'n=11&speaker=4', { ...D, w: 360, h: 740, lang: 'en' }],
  ['mobile-360-chat-sheet', 'n=5&speaker=2&panel=chat', { ...D, w: 360, h: 740 }],
  ['mobile-360-more-menu', 'n=5&speaker=2', { ...D, w: 360, h: 740 }, async (p) => { await p.locator(tid('more')).click(); await p.waitForTimeout(250); }],
  ['mobile-360-ru-light', 'n=6&speaker=2&hands=3', { ...D, w: 360, h: 740, lang: 'ru', theme: 'light' }],
  ['mobile-360-share', 'n=5&share=1&speaker=2', { ...D, w: 360, h: 740, lang: 'en', theme: 'light' }],
];
const picked = quick ? SHOTS.filter((s) => ['davra-n8', 'mobile-360-davra-n5', 'menu-more'].includes(s[0])) : SHOTS;

for (const [name, query, cfg, action, motion = 'reduce', delay] of picked) {
  const ctx = await browser.newContext({ viewport: { width: cfg.w, height: cfg.h }, deviceScaleFactor: 1, reducedMotion: motion });
  await ctx.addInitScript(([t, l]) => { localStorage.setItem('theme', t); localStorage.setItem('lang', l); }, [cfg.theme, cfg.lang]);
  const page = await ctx.newPage();
  const bad = [];
  page.on('pageerror', (e) => bad.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && bad.push(`console: ${m.text()}`));
  await page.goto(`${base}/lab/call?ui=0&theme=${cfg.theme}&lang=${cfg.lang}&${query}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector('.call');
  await page.waitForTimeout(500);
  if (action) await action(page);
  if (delay) await page.waitForTimeout(delay);
  let q = 82;
  let file = join(out, `${name}-${cfg.theme}-${cfg.w}-${cfg.lang}.jpg`);
  let buf;
  for (; q >= 40; q -= 8) {
    buf = await page.screenshot({ type: 'jpeg', quality: q });
    if (buf.length <= MAX) break;
  }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, buf);
  console.log(`${buf.length <= MAX ? 'ok  ' : 'BIG '} ${(buf.length / 1024).toFixed(0).padStart(4)} KB q${q}  ${file.split(/[\\/]/).pop()}  ${bad.length ? 'ISSUES: ' + bad.join(' | ') : ''}`);
  await ctx.close();
}
await browser.close();
void statSync;
