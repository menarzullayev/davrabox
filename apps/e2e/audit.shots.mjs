// UI/UX audit of the live site: every main screen at phone, tablet, laptop and desktop sizes, dark and light, with
// layout measurements (horizontal overflow, small touch targets, clipped text). Signs in with a dedicated audit account
// whose credentials live OUTSIDE the repository:
//   AUDIT_ACCOUNT=E:/projects/davrabox-builds/audit/.audit-account.json AUDIT_OUT=E:/projects/davrabox-builds/audit/run1 node audit.shots.mjs [filter]
// Writes <out>/<theme>-<size>/<nn>-<screen>.png and <out>/metrics.json. Uses system Edge with fake camera/microphone.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.AUDIT_BASE ?? 'https://davrabox.bugvector.uz';
const acct = JSON.parse(readFileSync(process.env.AUDIT_ACCOUNT ?? '', 'utf8'));
const OUT = process.env.AUDIT_OUT ?? 'audit-out';
const filter = process.argv[2] ?? '';
const SIZES = [
  { name: 'phone', width: 360, height: 780, mobile: true },
  { name: 'tablet', width: 768, height: 1024, mobile: true },
  { name: 'laptop', width: 1280, height: 800, mobile: false },
  { name: 'desktop', width: 1920, height: 1080, mobile: false },
];
const THEMES = ['dark', 'light'];
const metrics = [];

const measure = (page, touch) =>
  page.evaluate((touch) => {
    const vw = document.documentElement.clientWidth;
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const name = (e) => (e.getAttribute('aria-label') || e.textContent || e.getAttribute('data-testid') || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
    const overflow = [...document.querySelectorAll('body *')].filter((e) => vis(e) && getComputedStyle(e).position !== 'fixed' && e.getBoundingClientRect().right > vw + 1 && !e.closest('svg')).slice(0, 5).map((e) => `${(typeof e.className === 'string' && e.className.split(' ')[0]) || e.tagName}@${Math.round(e.getBoundingClientRect().right)}`);
    const min = touch ? 44 : 32;
    const small = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, [role=button], [role=tab], [role=option]')].filter((e) => { if (!vis(e)) return false; const lab = e.closest('label'); if (lab && lab.getBoundingClientRect().height >= min) return false; const r = e.getBoundingClientRect(); return (r.height < min || r.width < min) && !(e.tagName === 'A' && e.closest('p')); }).slice(0, 8).map((e) => { const r = e.getBoundingClientRect(); return `${name(e)} ${Math.round(r.width)}x${Math.round(r.height)}`; });
    const srOnly = (e) => { const s = getComputedStyle(e); return e.getBoundingClientRect().width <= 2 || s.clipPath.includes('inset(50%') || s.clip.startsWith('rect(0'); };
    const clipped = [...document.querySelectorAll('h1, h2, h3, p, label, button, a, span')].filter((e) => vis(e) && !srOnly(e) && e.children.length === 0 && e.scrollWidth > e.clientWidth + 2 && ['hidden', 'clip'].includes(getComputedStyle(e).overflowX)).slice(0, 5).map(name);
    return { vw, scrollWidth: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, overflow, small, clipped };
  }, touch);

async function shot(page, dir, n, screen, size) {
  await page.waitForTimeout(600);
  const file = join(dir, `${String(n).padStart(2, '0')}-${screen}.png`);
  await page.screenshot({ path: file, fullPage: false });
  const m = await measure(page, size.mobile);
  metrics.push({ screen, size: size.name, theme: dir.split(/[\\/]/).pop().split('-')[0], file, ...m });
}

async function signIn(page) {
  await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /^(Sign in|Kirish|Войти)/ }).first().click();
  await page.waitForSelector('input[name=username]', { timeout: 20000 });
  await page.fill('input[name=username]', acct.username);
  await page.fill('input[name=password]', acct.password);
  await page.press('input[name=password]', 'Enter');
  await page.waitForSelector('.home', { timeout: 30000 });
}

const browser = await chromium.launch({ channel: 'msedge', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
for (const theme of THEMES) {
  for (const size of SIZES) {
    const key = `${theme}-${size.name}`;
    if (filter && !key.includes(filter)) continue;
    const dir = join(OUT, key);
    mkdirSync(dir, { recursive: true });
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.mobile, hasTouch: size.mobile, permissions: ['camera', 'microphone'], locale: 'en-US' });
    await ctx.addInitScript((t) => { try { localStorage.setItem('theme', t); localStorage.setItem('lang', 'en'); } catch {} }, theme);
    const page = await ctx.newPage();
    let n = 1;
    const step = async (screen, fn) => {
      try { await fn(); await shot(page, dir, n++, screen, size); } catch (e) { metrics.push({ screen, size: size.name, theme, error: String(e.message).slice(0, 160) }); n++; }
    };
    // Public screens
    await step('landing', () => page.goto(`${BASE}/`, { waitUntil: 'networkidle' }));
    await step('landing-scrolled', () => page.evaluate(() => scrollTo(0, innerHeight * 1.5)));
    await step('app-signin', () => page.goto(`${BASE}/app`, { waitUntil: 'networkidle' }));
    await step('guest-join', () => page.goto(`${BASE}/app?join=72878384891`, { waitUntil: 'networkidle' }));
    await step('signup', async () => { await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' }); await page.getByRole('link', { name: /Create an organisation/i }).first().click(); await page.waitForTimeout(1200); });
    await step('keycloak-login', async () => { await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' }); await page.getByRole('button', { name: /^Sign in/ }).first().click(); await page.waitForSelector('input[name=username]'); });
    // Signed in
    await step('home', () => signIn(page));
    await step('home-scrolled', () => page.evaluate(() => scrollTo(0, document.body.scrollHeight)));
    await step('settings-menu', async () => { await page.evaluate(() => scrollTo(0, 0)); await page.getByTestId('settings').first().click(); });
    await step('new-meeting', async () => { await page.keyboard.press('Escape'); await page.getByTestId('new-meeting').first().click(); await page.waitForSelector('[data-testid=meeting-title]'); });
    await step('prejoin', async () => {
      await page.fill('[data-testid=meeting-title]', `Audit ${size.name} ${theme}`);
      await page.getByRole('button', { name: /^(Create|Yaratish|Создать)/ }).click();
      await page.waitForTimeout(1500);
      await page.getByRole('button', { name: new RegExp(`Join.*Audit ${size.name} ${theme}`) }).first().click();
      await page.waitForSelector('[data-testid=prejoin]', { timeout: 15000 });
    });
    await step('call', async () => { await page.getByTestId('prejoin-join').click(); await page.waitForSelector('.call', { timeout: 30000 }); await page.waitForTimeout(2500); });
    await step('call-chat', async () => { await page.getByRole('button', { name: /^Chat/ }).first().click(); });
    await step('call-people', async () => { await page.keyboard.press('Escape'); const t = page.getByTestId('people-toggle'); if (await t.first().isVisible()) await t.first().click(); else { await page.getByTestId('more').first().click(); await page.getByRole('button', { name: /^People/ }).first().click(); } });
    await step('call-more', async () => { await page.keyboard.press('Escape'); await page.getByTestId('more').first().click(); });
    await step('after-leave', async () => { await page.keyboard.press('Escape'); await page.getByRole('button', { name: /^Leave$/ }).first().click(); await page.waitForTimeout(1500); });
    await ctx.close();
    console.log('done', key, n - 1);
  }
}
await browser.close();
writeFileSync(join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2));
const bad = metrics.filter((m) => m.error || (m.overflow && m.overflow.length) || (m.small && m.small.length) || (m.clipped && m.clipped.length));
console.log(`screens ${metrics.length}, with findings ${bad.length}, errors ${metrics.filter((m) => m.error).length}`);
