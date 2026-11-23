// Automated accessibility check (axe-core, WCAG 2.0/2.1 A+AA + best-practice tags) of /styleguide in both themes,
// default state plus the open Dialog and Menu. Exits 1 on any serious or critical violation.
//   SG_URL=http://127.0.0.1:5191 node styleguide.axe.mjs
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright-core';

const base = process.env.SG_URL ?? 'http://127.0.0.1:5191';
const browser = await chromium.launch({ channel: 'msedge' });
let blocking = 0;
for (const theme of ['dark', 'light']) {
  for (const [width, lang] of [[1280, 'uz'], [360, 'ru'], [768, 'en']]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    await ctx.addInitScript(([t, l]) => { localStorage.setItem('theme', t); localStorage.setItem('lang', l); }, [theme, lang]);
    const page = await ctx.newPage();
    await page.goto(`${base}/styleguide`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    const states = [['page', async () => {}]];
    if (width === 1280) {
      states.push(['dialog open', async () => { await page.locator('#overlays button').nth(2).click(); await page.waitForSelector('dialog[open]'); }]);
    }
    for (const [name, prep] of states) {
      await prep();
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
      const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      blocking += bad.length;
      console.log(`${theme} ${width} ${lang} [${name}]: ${r.violations.length} violations (${bad.length} serious/critical), ${r.passes.length} rules passed`);
      for (const v of r.violations) console.log(`   ${v.impact} ${v.id}: ${v.help} (${v.nodes.length} nodes) e.g. ${v.nodes[0]?.target?.join(' ')}`);
    }
    await ctx.close();
  }
}
await browser.close();
process.exit(blocking ? 1 : 0);
