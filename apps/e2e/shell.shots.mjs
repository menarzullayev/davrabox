// Screenshots of the signed-in shell and the home package pages in every style (lab build, fake data): a visual check of the
// left panel, the phone tab bar and the new blocks. Needs the dev server: `pnpm --filter @davrabox/web dev --port 5181`.
//   node shell.shots.mjs [outDir] [baseUrl]
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const OUT = process.argv[2] ?? 'shots/shell';
const BASE = process.argv[3] ?? 'http://127.0.0.1:5181';
const STYLES = ['dashboard', 'swiss', 'flat', 'material', 'editorial', 'neobrutalism', 'terminal', 'glassmorphism', 'neumorphism', 'claymorphism', 'aurora', 'skeuomorphism', 'liquid-glass'];
const PAGES = (process.env.PAGES ?? 'home').split(',');
const SIZES = { desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } };
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' });
const problems = [];
for (const style of STYLES) {
  for (const [size, viewport] of Object.entries(SIZES)) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: style === 'terminal' ? 'dark' : 'light' });
    await ctx.addInitScript((s) => localStorage.setItem('style', s), style);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { if (!/WebSocket closed/.test(e.message)) problems.push(`${style}/${size}: ${e.message}`); }); // the dev server's HMR socket is not part of the page
    for (const p of PAGES) {
      await page.goto(`${BASE}/lab/home?screen=home&state=trial&lang=en&section=${p}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(600);
      // Nothing may stick out sideways (a horizontal scroll on a phone is a layout bug).
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) problems.push(`${style}/${size}/${p}: horizontal overflow ${overflow}px`);
      const tabbar = await page.locator('.hm-tabbar').isVisible();
      if ((size === 'phone') !== tabbar) problems.push(`${style}/${size}/${p}: tab bar visible=${tabbar}`);
      const panel = await page.locator('.sh-panel').isVisible();
      if ((size === 'desktop') !== panel) problems.push(`${style}/${size}/${p}: left panel visible=${panel}`);
      await page.screenshot({ path: join(OUT, `${p}-${style}-${size}.png`), fullPage: false });
    }
    await ctx.close();
  }
}
await browser.close();
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no layout problems found');
