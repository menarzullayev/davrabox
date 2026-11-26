// Audit of the landing page, /help and the sign-up page (plus the open mega-menu, menu sheet and help assistant): axe-core (WCAG 2.0/2.1 A+AA + best-practice) in dark and light at 360, 768,
// 1280 and 1920 px in uz, ru and en; no horizontal overflow; no request to another origin; no console error.
// Exits 1 on any serious or critical violation, overflow, foreign request or error.
//   LANDING_URL=http://127.0.0.1:5231 node landing.axe.mjs      (a production build served with `vite preview`; no backend needed)
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright-core';

const base = process.env.LANDING_URL ?? 'http://127.0.0.1:5231';
const origin = new URL(base).origin;
const pages = [['landing', '/'], ['help', '/help'], ['signup', '/app/signup']];
const widths = [360, 768, 1280, 1920];
const langs = ['uz', 'ru', 'en'];

const browser = await chromium.launch({ channel: 'msedge' });
let blocking = 0;
let runs = 0;
for (const theme of ['dark', 'light']) {
  for (const lang of langs) {
    for (const width of widths) {
      for (const [name, path] of pages) {
        const ctx = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        await ctx.addInitScript(([t, l]) => { localStorage.setItem('theme', t); localStorage.setItem('lang', l); }, [theme, lang]);
        const page = await ctx.newPage();
        const foreign = [];
        const errors = [];
        page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) foreign.push(r.url()); });
        page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
        page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
        await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);
        // Overlays of the landing package: the open mega-menu (wide) or menu sheet (narrow), then the assistant window.
        if (name === 'landing' && lang === 'en') {
          if (width >= 960) await page.getByTestId('menu-trigger-product').click();
          else await page.getByTestId('menu-open').click();
        }
        if (name === 'help' && width === 1280) {
          await page.getByTestId('assistant-open').click();
          await page.getByTestId('assistant-panel').waitFor();
        }
        const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
        const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        runs += 1;
        const problems = [
          ...bad.map((v) => `axe ${v.id} (${v.impact}): ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`),
          ...(overflow > 0 ? [`horizontal overflow ${overflow}px`] : []),
          ...(foreign.length ? [`foreign requests: ${foreign.join(', ')}`] : []),
          ...errors,
        ];
        blocking += problems.length;
        console.log(`${problems.length ? 'FAILED' : 'PASSED'}  ${name} ${theme} ${lang} ${width}px${problems.length ? ' :: ' + problems.join(' ;; ') : ''}`);
        await ctx.close();
      }
    }
  }
}
await browser.close();
console.log(`${runs} page checks, ${blocking} problems`);
process.exit(blocking ? 1 : 0);
