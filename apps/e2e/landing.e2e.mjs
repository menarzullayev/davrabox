// End-to-end: the public landing package against a production build and a real API (help assistant in FAQ mode).
// Mega-menu and menu sheet, pricing, downloads, demo clips (lazy), /help (search, FAQ anchors), the help assistant
// (FAQ answer from the server, the fixed reply, the stored-conversation notice), and the sign-in screen's button.
//   BASE_URL=http://127.0.0.1:5240 node landing.e2e.mjs     (serve-dist.mjs in front of an API with ASSISTANT_LLM=none)
import { chromium } from 'playwright-core';

const base = process.env.BASE_URL ?? 'http://127.0.0.1:5240';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${detail ? ` :: ${detail}` : ''}`);
};

const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL ?? 'msedge' });
const errors = [];
async function open(path, { width = 1366, height = 900, lang = 'en' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript((l) => localStorage.setItem('lang', l), lang);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${path}: ${e.message}`));
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  return { ctx, page };
}

try {
  // ---- desktop landing ------------------------------------------------------------------------------------------
  {
    const { ctx, page } = await open('/');
    const product = page.getByTestId('menu-trigger-product');
    await product.click();
    const panelVisible = await page.locator(`#${await product.getAttribute('aria-controls')}`.replace(/:/g, '\\:')).isVisible();
    check('mega-menu: Product opens a panel with described links', panelVisible && (await page.getByTestId('menu-security').isVisible()));
    await page.keyboard.press('Escape');
    check('mega-menu: Escape closes and returns focus', (await product.getAttribute('aria-expanded')) === 'false' && (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) === 'menu-trigger-product');
    await page.getByTestId('menu-pricing').click();
    await page.waitForTimeout(300);
    check('pricing: three plans, real trial limits, contact links', (await page.getByTestId('plan').count()) === 3 && /Up to 10 participants/.test(await page.getByTestId('plan').first().innerText()));
    const demo = page.locator('[data-testid=demo] video').first();
    check('demo clips: no source before they are near the viewport', (await demo.getAttribute('src')) === null);
    await page.locator('#demo').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const v = document.querySelector('[data-testid=demo] video');
      return v && v.getAttribute('src') && v.readyState >= 2;
    }, null, { timeout: 15_000 }).catch(() => undefined);
    const state = await demo.evaluate((v) => ({ src: v.getAttribute('src'), ready: v.readyState, muted: v.muted, paused: v.paused, w: v.videoWidth }));
    check('demo clips: load and play muted when visible', !!state.src && state.ready >= 2 && state.muted && !state.paused && state.w === 960, JSON.stringify(state));
    await page.locator('#download').scrollIntoViewIfNeeded();
    const dl = await page.getByTestId('download-android').innerText();
    const hasLink = await page.getByTestId('download-link-android').count();
    check('downloads: a file with checksum, or a clear "not published" note', hasLink ? /SHA-256/.test(dl) : /not published/.test(dl), dl.replace(/\s+/g, ' ').slice(0, 120));
    check('downloads: unsigned-beta warning', /not signed yet/.test(await page.getByTestId('beta-warning').innerText()));
    if (hasLink) {
      const href = await page.getByTestId('download-link-android').getAttribute('href');
      const head = await page.request.head(`${base}${href}`);
      check('downloads: the APK is served from this server', head.ok());
    }
    await ctx.close();
  }

  // ---- phone landing: menu sheet ----------------------------------------------------------------------------------
  {
    const { ctx, page } = await open('/', { width: 390, height: 844, lang: 'uz' });
    await page.getByTestId('menu-open').click();
    const sheet = page.getByRole('dialog');
    check('menu sheet: opens as a modal dialog on a phone', (await sheet.getAttribute('aria-modal')) === 'true' && (await sheet.getByRole('link').count()) >= 10);
    await page.keyboard.press('Escape');
    check('menu sheet: Escape closes it', (await page.getByTestId('menu-sheet').count()) === 0);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('phone: no horizontal overflow', overflow <= 0, `${overflow}px`);
    await ctx.close();
  }

  // ---- /help -------------------------------------------------------------------------------------------------------
  {
    const { ctx, page } = await open('/help', { lang: 'ru' });
    check('/help: one h1 and every FAQ entry', (await page.locator('h1').count()) === 1 && (await page.getByTestId('faq').count()) >= 20);
    await page.getByTestId('help-search').fill('не работает камера');
    const first = page.getByTestId('help-results').getByRole('link').first();
    await first.click();
    check('/help: search result opens the FAQ entry', await page.locator('#faq-camera-mic').evaluate((d) => d.open));
    await ctx.close();
    const deep = await open('/help#guide-android-install');
    check('/help: a guide anchor from the landing page exists', await deep.page.locator('#guide-android-install').isVisible());
    await deep.ctx.close();
  }

  // ---- help assistant (FAQ mode) -----------------------------------------------------------------------------------
  {
    const { ctx, page } = await open('/help');
    await page.getByTestId('assistant-open').click();
    const panel = page.getByTestId('assistant-panel');
    await panel.waitFor();
    check('assistant: says conversations are stored', /kept for 30 days/.test(await page.getByTestId('assistant-stored').innerText()));
    await page.getByTestId('assistant-input').fill('How do I share my screen?');
    check('assistant: offers FAQ answers while typing', (await page.getByTestId('assistant-ready').count()) === 1);
    const ask = page.waitForResponse((r) => r.url().endsWith('/api/v1/public/assistant/ask'));
    await page.getByTestId('assistant-send').click();
    const r1 = await (await ask).json();
    check('assistant: the server answers a FAQ question from the FAQ', r1.source === 'faq' && r1.faqId === 'screen-share', JSON.stringify({ source: r1.source, faqId: r1.faqId }));
    await page.getByTestId('assistant-input').fill('qwerty zxcvb lorem ipsum dolor');
    const ask2 = page.waitForResponse((r) => r.url().endsWith('/api/v1/public/assistant/ask'));
    await page.keyboard.press('Enter');
    const r2 = await (await ask2).json();
    check('assistant: without a model it gives the fixed FAQ-mode reply', r2.source === 'fallback' && r2.conversationId === r1.conversationId, r2.answer?.slice(0, 80));
    await page.keyboard.press('Escape');
    check('assistant: Escape closes the window', (await panel.count()) === 0);
    await ctx.close();
  }

  // ---- sign-in screen has the button ---------------------------------------------------------------------------
  {
    const { ctx, page } = await open('/app', { lang: 'uz' });
    await page.getByTestId('signin').waitFor({ timeout: 15_000 }).catch(() => undefined);
    check('sign-in: has the assistant button', (await page.getByTestId('assistant-open').count()) === 1);
    await ctx.close();
  }
} catch (e) {
  check('no unexpected exception', false, e.message);
}
await browser.close();
check('no page errors', errors.length === 0, errors.join(' | '));
const failed = results.filter((r) => !r.ok).length;
console.log(`landing.e2e: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
