// Automated accessibility check (axe-core, WCAG 2.0/2.1 A+AA + best-practice tags) of every home-lab state in both
// themes: sign-in, waiting, loading, home (few/many/long/empty/loading/error), the open new-meeting dialog, the open
// settings menu and the join field with an invalid entry. Exits 1 on any serious or critical violation.
//   node home.axe.mjs      (needs the lab build served on HOME_URL, default http://127.0.0.1:5192; see home.shots.mjs)
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright-core';

const base = process.env.HOME_URL ?? 'http://127.0.0.1:5192';
const states = [
  ['signin', { screen: 'signin' }],
  ['waiting', { screen: 'waiting' }],
  ['loading', { screen: 'loading' }],
  ['home few', { screen: 'home', state: 'few' }],
  ['home many', { screen: 'home', state: 'many' }],
  ['home long', { screen: 'home', state: 'long' }],
  ['home empty', { screen: 'home', state: 'empty' }],
  ['home loading', { screen: 'home', state: 'loading' }],
  ['home error', { screen: 'home', state: 'error' }],
  ['home few + dialog', { screen: 'home', state: 'few' }, 'dialog'],
  ['home few + settings', { screen: 'home', state: 'few' }, 'settings'],
  ['home few + invalid code', { screen: 'home', state: 'few' }, 'invalid'],
  ['home passcode prefill', { screen: 'home', state: 'passcode' }],
  ['signin + settings', { screen: 'signin' }, 'settings'],
];
const viewports = [[1280, 'uz'], [360, 'ru'], [768, 'en']];

const browser = await chromium.launch({ channel: 'msedge' });
let blocking = 0;
let runs = 0;
for (const theme of ['dark', 'light']) {
  for (const [width, lang] of viewports) {
    for (const [name, q, prep] of states) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', timezoneId: 'Asia/Tashkent' });
      await ctx.addInitScript(([t, l]) => { localStorage.setItem('theme', t); localStorage.setItem('lang', l); }, [theme, lang]);
      const page = await ctx.newPage();
      await page.goto(`${base}/lab/home?${new URLSearchParams({ ...q, lang, theme })}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      if (prep === 'dialog') {
        await page.getByTestId('new-meeting').click();
        await page.waitForSelector('dialog[open] [data-testid=meeting-title]');
      } else if (prep === 'settings') {
        await page.getByTestId('settings').click();
        await page.waitForSelector('.dx-popover:not([data-pending])');
      } else if (prep === 'invalid') {
        await page.locator('[data-testid=join-form] input[inputmode=numeric]').fill('12ab');
      }
      await page.waitForTimeout(350); // let entry animations settle so contrast is measured on the final colours
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
      const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      blocking += bad.length;
      runs++;
      console.log(`${theme} ${width} ${lang} [${name}]: ${r.violations.length} violations (${bad.length} serious/critical), ${r.passes.length} rules passed`);
      for (const v of r.violations) console.log(`   ${v.impact} ${v.id}: ${v.help} (${v.nodes.length} nodes) e.g. ${v.nodes[0]?.target?.join(' ')}`);
      await ctx.close();
    }
  }
}
await browser.close();
console.log(`${runs} axe runs, ${blocking} serious/critical violations`);
process.exit(blocking ? 1 : 0);
