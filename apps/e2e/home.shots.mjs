// Screenshots of the home, sign-in and waiting screens from the home lab (fake data, no backend):
// docs/design/screenshots/wave1-home/. The lab only exists in a build made with VITE_HOME_LAB=1:
//   cd apps/web && VITE_HOME_LAB=1 pnpm exec vite build --outDir dist-lab && pnpm exec vite preview --outDir dist-lab --port 5192 --strictPort
//   node home.shots.mjs            -> the whole matrix
//   node home.shots.mjs <filter>   -> only cases whose name contains <filter> (for iteration)
// Every file is kept under 200 KB (PNG, else JPEG with a falling quality).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const base = process.env.HOME_URL ?? 'http://127.0.0.1:5192';
const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.HOME_OUT ?? join(here, '..', '..', 'docs', 'design', 'screenshots', 'wave1-home');
mkdirSync(out, { recursive: true });
const filter = process.argv[2] ?? '';
const LIMIT = 200 * 1024;

/** @type {Array<{screen:string,state?:string,theme:string,width:number,lang:string,height?:number,full?:boolean,prep?:string}>} */
const cases = [];
const add = (c) => cases.push(c);
for (const theme of ['dark', 'light']) {
  for (const width of [360, 768, 1280, 1920]) {
    add({ screen: 'signin', theme, width, lang: 'uz' });
    add({ screen: 'home', state: 'few', theme, width, lang: 'uz', full: true });
    add({ screen: 'waiting', theme, width, lang: 'uz' });
  }
}
for (const lang of ['ru', 'en']) {
  add({ screen: 'signin', theme: 'dark', width: 1280, lang });
  add({ screen: 'home', state: 'few', theme: 'dark', width: 1280, lang, full: true });
  add({ screen: 'home', state: 'few', theme: 'light', width: 360, lang, full: true });
  add({ screen: 'waiting', theme: 'dark', width: 1280, lang });
}
for (const theme of ['dark', 'light']) {
  add({ screen: 'home', state: 'empty', theme, width: 1280, lang: 'uz', full: true });
  add({ screen: 'home', state: 'empty', theme, width: 360, lang: 'uz', full: true });
  add({ screen: 'home', state: 'many', theme, width: 1280, lang: 'uz', full: true });
  add({ screen: 'home', state: 'many', theme, width: 360, lang: 'uz', full: true });
  add({ screen: 'home', state: 'long', theme, width: 1280, lang: 'uz', full: true });
  add({ screen: 'home', state: 'long', theme, width: 360, lang: 'ru', full: true });
  add({ screen: 'home', state: 'loading', theme, width: 1280, lang: 'uz', full: true });
  add({ screen: 'home', state: 'error', theme, width: 1280, lang: 'uz', full: true });
  add({ screen: 'home', state: 'few', theme, width: 1280, lang: 'uz', prep: 'dialog' });
  add({ screen: 'home', state: 'few', theme, width: 360, lang: 'ru', prep: 'dialog' });
  add({ screen: 'home', state: 'few', theme, width: 1280, lang: 'uz', prep: 'settings' });
  add({ screen: 'home', state: 'few', theme, width: 360, lang: 'en', prep: 'settings' });
  add({ screen: 'home', state: 'few', theme, width: 1280, lang: 'uz', prep: 'link' });
  add({ screen: 'home', state: 'few', theme, width: 1280, lang: 'uz', prep: 'invalid' });
}
add({ screen: 'home', state: 'many', theme: 'dark', width: 3840, lang: 'uz', height: 2160 });
add({ screen: 'home', state: 'few', theme: 'dark', width: 1280, lang: 'uz', prep: 'focus' });

const nameOf = (c) => [c.screen, c.state, c.prep, c.theme, c.width, c.lang].filter(Boolean).join('-');

const browser = await chromium.launch({ channel: 'msedge' });
let written = 0;
for (const c of cases) {
  const name = nameOf(c);
  if (filter && !name.includes(filter)) continue;
  const ctx = await browser.newContext({ viewport: { width: c.width, height: c.height ?? 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce', timezoneId: 'Asia/Tashkent' });
  await ctx.addInitScript(([t, l]) => {
    localStorage.setItem('theme', t);
    localStorage.setItem('lang', l);
  }, [c.theme, c.lang]);
  const page = await ctx.newPage();
  const bad = [];
  page.on('pageerror', (e) => bad.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && bad.push(`console: ${m.text()}`));
  page.on('requestfailed', (r) => bad.push(`requestfailed: ${r.url()}`));
  const qs = new URLSearchParams({ screen: c.screen, ...(c.state ? { state: c.state } : {}), lang: c.lang, theme: c.theme });
  await page.goto(`${base}/lab/home?${qs}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  if (c.prep === 'dialog') {
    await page.getByTestId('new-meeting').click();
    await page.waitForSelector('dialog[open] [data-testid=meeting-title]');
    await page.waitForTimeout(250);
  } else if (c.prep === 'settings') {
    await page.getByTestId('settings').click();
    await page.waitForSelector('.dx-popover:not([data-pending])');
    await page.waitForTimeout(250);
  } else if (c.prep === 'link') {
    await page.locator('[data-testid=join-form] input[inputmode=numeric]').fill('https://davrabox.example.test/?join=30812345678');
    await page.waitForTimeout(150);
  } else if (c.prep === 'invalid') {
    await page.locator('[data-testid=join-form] input[inputmode=numeric]').fill('12ab');
    await page.waitForTimeout(150);
  } else if (c.prep === 'focus') {
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
  }
  const shot = async (type, quality) => page.screenshot({ type, quality, fullPage: Boolean(c.full) });
  let file = join(out, `${name}.png`);
  let buf = await shot('png');
  if (buf.length > LIMIT) {
    file = join(out, `${name}.jpg`);
    for (const q of [86, 78, 70, 62, 54]) {
      buf = await shot('jpeg', q);
      if (buf.length <= LIMIT) break;
    }
  }
  writeFileSync(file, buf);
  written++;
  console.log(file.replace(out, '').slice(1), `${Math.round(buf.length / 1024)} KB`, buf.length > LIMIT ? 'OVER LIMIT' : '', bad.length ? `ISSUES: ${bad.join(' | ')}` : 'clean');
  await ctx.close();
}
await browser.close();
console.log(`${written} screenshots in ${out}`);
