// Screenshots of /styleguide for the design-system evidence (docs/design/screenshots/wave1-system/).
//   node styleguide.shots.mjs            -> matrix (themes x widths x languages): per case a top frame and a components frame
//   node styleguide.shots.mjs quick      -> one dark 1280 uz shot into $SG_OUT (default: scratch dir) for iteration
// Needs a running server on SG_URL (default http://127.0.0.1:5191), e.g. `pnpm exec vite preview --port 5191`.
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const base = process.env.SG_URL ?? 'http://127.0.0.1:5191';
const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.SG_OUT ?? join(here, '..', '..', 'docs', 'design', 'screenshots', 'wave1-system');
mkdirSync(out, { recursive: true });
const quick = process.argv[2] === 'quick';

const browser = await chromium.launch({ channel: 'msedge' });
async function open(theme, width, lang, height = 1100) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await ctx.addInitScript(([t, l]) => {
    localStorage.setItem('theme', t);
    localStorage.setItem('lang', l);
  }, [theme, lang]);
  const page = await ctx.newPage();
  const bad = [];
  page.on('pageerror', (e) => bad.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && bad.push(`console: ${m.text()}`));
  page.on('requestfailed', (r) => bad.push(`requestfailed: ${r.url()}`));
  await page.goto(`${base}/styleguide`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  return { ctx, page, bad };
}

const cases = quick
  ? [['dark', 1280, 'uz']]
  : [
      ['dark', 360, 'uz'], ['dark', 768, 'uz'], ['dark', 1280, 'uz'], ['dark', 1280, 'en'], ['dark', 1280, 'ru'],
      ['light', 360, 'uz'], ['light', 768, 'uz'], ['light', 1280, 'uz'], ['light', 1280, 'en'],
    ];
for (const [theme, width, lang] of cases) {
  const { ctx, page, bad } = await open(theme, width, lang);
  const frames = quick ? [['quick', null]] : [['top', null], ['components', '#buttons'], ['forms', '#fields']];
  for (const [name, anchor] of frames) {
    if (anchor) await page.locator(anchor).evaluate((el) => el.scrollIntoView());
    else await page.evaluate(() => window.scrollTo(0, 0));
    const file = quick ? join(out, 'quick.png') : join(out, `${name}-${theme}-${width}-${lang}.png`);
    await page.screenshot({ path: file, type: 'png' });
    console.log(file, bad.length ? `ISSUES: ${bad.join(' | ')}` : 'clean');
  }
  await ctx.close();
}

if (!quick) {
  // Keyboard focus: tab through the header and buttons, capture the viewport with the focus ring visible.
  const { ctx, page } = await open('dark', 1280, 'en', 800);
  await page.locator('#buttons').scrollIntoViewIfNeeded();
  await page.locator('#buttons').evaluate((el) => el.scrollIntoView());
  const first = page.locator('#buttons .sg-table button').first();
  await first.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.screenshot({ path: join(out, 'focus-dark-1280-en.png'), type: 'png' });
  await ctx.close();
  const l = await open('light', 1280, 'en', 800);
  await l.page.locator('#fields').evaluate((el) => el.scrollIntoView());
  await l.page.locator('#fields input').first().focus();
  await l.page.keyboard.press('Tab');
  await l.page.screenshot({ path: join(out, 'focus-light-1280-en.png'), type: 'png' });
  await l.ctx.close();
}
await browser.close();
