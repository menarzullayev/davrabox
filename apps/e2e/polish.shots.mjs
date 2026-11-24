// Screenshots plus axe of the lab states touched by the polish pass (critic D-07, D-10, D-13, D-15, P-01, P-04, P-05, P-07).
//   LAB_URL=http://127.0.0.1:5391 node polish.shots.mjs [out-dir] [--axe-only]
// Needs `pnpm exec vite --port 5391` in apps/web (the lab pages exist in development builds). Uses the system Edge.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright-core';

const base = process.env.LAB_URL ?? 'http://127.0.0.1:5391';
const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : join(here, '..', '..', 'docs', 'design', 'screenshots', 'polish');
const axeOnly = process.argv.includes('--axe-only');
mkdirSync(out, { recursive: true });
const MAX = 120 * 1024;
const tid = (id) => `[data-testid="${id}"]`;

const call = (q) => `/lab/call?ui=0&${q}`;
const home = (q) => `/lab/home?${q}`;
const D = { theme: 'dark', lang: 'en', w: 1280, h: 720 };
const SHOTS = [
  // name, path, cfg, ready selector, action
  ['n2-davra', call('n=2&speaker=1'), D, '.call'],
  ['n2-davra', call('n=2&speaker=1'), { ...D, theme: 'light', w: 768, h: 1024 }, '.call'],
  ['n2-davra', call('n=2&speaker=1'), { ...D, w: 360, h: 740 }, '.call'],
  ['autogrid-hint', call('n=13&speaker=4'), D, '.dv-hintbar'],
  ['autogrid-hint', call('n=13&speaker=4'), { ...D, theme: 'light', w: 360, h: 740, lang: 'ru' }, '.dv-hintbar'],
  ['layout-popover-focus', call('n=6&speaker=2&mode=gallery'), D, '.call', async (p) => { await p.locator(tid('layout')).focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(300); }],
  ['layout-popover-focus', call('n=6&speaker=2&mode=gallery'), { ...D, theme: 'light', lang: 'ru' }, '.call', async (p) => { await p.locator(tid('layout')).focus(); await p.keyboard.press('Enter'); await p.waitForTimeout(300); }],
  ['more-shows-view', call('n=5&speaker=2&mode=gallery'), { ...D, w: 360, h: 740 }, '.call'],
  ['more-shows-view', call('n=5&speaker=2&mode=speaker'), { ...D, theme: 'light', w: 360, h: 740, lang: 'ru' }, '.call'],
  ['share-label', call('n=4&share=1&speaker=2'), D, '.call'],
  ['share-label', call('n=4&share=1&speaker=2'), { ...D, theme: 'light' }, '.call'],
  ['join-closed', home('screen=home&state=few'), D, '.hm-join'],
  ['join-closed', home('screen=home&state=few'), { ...D, theme: 'light', w: 360, h: 800, lang: 'ru' }, '.hm-join'],
  ['join-passcode-open', home('screen=home&state=few'), D, '.hm-join', async (p) => { await p.locator(tid('join-passcode-toggle')).focus(); await p.keyboard.press('Space'); await p.waitForTimeout(200); }],
  ['join-passcode-open', home('screen=home&state=few'), { ...D, theme: 'light', w: 360, h: 800, lang: 'uz' }, '.hm-join', async (p) => { await p.locator(tid('join-passcode-toggle')).focus(); await p.keyboard.press('Space'); await p.waitForTimeout(200); }],
  ['join-wrong-passcode', home('screen=home&state=error'), D, '.hm-join'],
  ['waiting', home('screen=waiting'), D, '[data-testid=waiting]'],
  ['waiting', home('screen=waiting'), { ...D, theme: 'light', w: 360, h: 740, lang: 'ru' }, '[data-testid=waiting]'],
];

const browser = await chromium.launch({ channel: 'msedge' });
let violations = 0;
let runs = 0;
for (const [name, path, cfg, ready, action] of SHOTS) {
  const ctx = await browser.newContext({ viewport: { width: cfg.w, height: cfg.h }, deviceScaleFactor: 1, reducedMotion: 'reduce', timezoneId: 'Asia/Tashkent' });
  await ctx.addInitScript(([t, l]) => { localStorage.setItem('theme', t); localStorage.setItem('lang', l); }, [cfg.theme, cfg.lang]);
  const page = await ctx.newPage();
  const bad = [];
  // The dev server's HMR socket points at the Caddy port and cannot open here: not an app error.
  page.on('pageerror', (e) => { if (!/WebSocket closed without opened/.test(e.message)) bad.push(`pageerror: ${e.message}`); });
  await page.goto(`${base}${path}${path.includes('?') ? '&' : '?'}theme=${cfg.theme}&lang=${cfg.lang}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector(ready);
  await page.waitForTimeout(500);
  if (action) await action(page);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  runs++;
  const v = r.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical');
  violations += r.violations.length;
  for (const x of r.violations) bad.push(`axe ${x.impact} ${x.id}: ${x.help} (${x.nodes.length}) ${x.nodes[0]?.target?.join(' ')}`);
  let line = `${name}-${cfg.theme}-${cfg.w}-${cfg.lang}`;
  if (!axeOnly) {
    let q = 80;
    let buf;
    for (; q >= 40; q -= 8) {
      buf = await page.screenshot({ type: 'jpeg', quality: q });
      if (buf.length <= MAX) break;
    }
    writeFileSync(join(out, `${line}.jpg`), buf);
    line += ` ${(buf.length / 1024).toFixed(0)} KB`;
  }
  console.log(`${bad.length ? 'ISSUE' : 'ok   '} ${line} ${bad.join(' | ')}${v.length ? ' [BLOCKING]' : ''}`);
  await ctx.close();
}
await browser.close();
console.log(`axe: ${runs} runs, ${violations} violations`);
process.exit(violations ? 1 : 0);
