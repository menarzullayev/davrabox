// Generates the hero screenshots of the landing page from the call-screen lab (the davra layout with demo participants):
//   apps/web/public/landing/call-davra-dark.jpg and call-davra-light.jpg  (1280x720, <= 150 KB each)
// Needs `VITE_CALL_LAB=1 pnpm --filter @davrabox/web build` and `pnpm exec vite preview --port 5231 --strictPort` in apps/web.
//   LAB_URL=http://127.0.0.1:5231 node landing.shots.mjs
// The lab is a development fixture: nothing real is shown (the names are demo data).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const base = process.env.LAB_URL ?? 'http://127.0.0.1:5231';
const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.LANDING_OUT ?? join(here, '..', 'web', 'public', 'landing');
mkdirSync(out, { recursive: true });
const MAX = 150 * 1024;

const browser = await chromium.launch({ channel: 'msedge' });
for (const theme of ['dark', 'light']) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await ctx.addInitScript(([t, l]) => { localStorage.setItem('theme', t); localStorage.setItem('lang', l); }, [theme, 'en']);
  const page = await ctx.newPage();
  await page.goto(`${base}/lab/call?ui=0&theme=${theme}&lang=en&n=8&speaker=3&hands=2&mute=4`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector('.call');
  await page.waitForTimeout(600);
  let buf;
  for (let q = 84; q >= 40; q -= 6) {
    buf = await page.screenshot({ type: 'jpeg', quality: q });
    if (buf.length <= MAX) break;
  }
  const file = join(out, `call-davra-${theme}.jpg`);
  writeFileSync(file, buf);
  console.log(`${buf.length <= MAX ? 'ok ' : 'BIG'} ${(buf.length / 1024).toFixed(0)} KB ${file}`);
  await ctx.close();
}
await browser.close();
