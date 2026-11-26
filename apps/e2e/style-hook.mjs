// Runs the e2e suite in one visual style: `E2E_STYLE=liquid-glass node --import ./style-hook.mjs <test>.mjs`.
// Every browser context the tests open starts with that style, also for test users who saved another style on the server
// (the prefs answer is rewritten for this context only, and the forced style is never written back to the server). The
// tests themselves are unchanged.
import { chromium } from 'playwright-core';

/** Makes one browser context show `style`: saved locally before load, and reported as the person's saved style by the API. */
export async function forceStyle(ctx, style) {
  if (!/^[a-z-]{1,32}$/.test(style)) throw new Error(`not a style id: ${style}`);
  await ctx.addInitScript((s) => {
    try {
      if (localStorage.getItem('style') === null) localStorage.setItem('style', s);
    } catch {
      /* opaque origins (about:blank) have no storage */
    }
  }, style);
  await ctx.route('**/v1/me/prefs', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      const res = await route.fetch();
      const body = await res.json().catch(() => null);
      if (!body?.prefs) return route.fulfill({ response: res });
      // Only when the organisation allows it: a test of the style policy must still see the policy.
      const allowed = !body.org?.allowedStyles || body.org.allowedStyles.includes(style);
      if (allowed) body.prefs.style = style;
      return route.fulfill({ response: res, json: body });
    }
    if (req.method() === 'PUT') {
      const patch = req.postDataJSON() ?? {};
      if (patch.style === style) delete patch.style; // never store the forced style for the test user
      if (Object.keys(patch).length === 0) return route.fulfill({ status: 200, json: {} });
      return route.continue({ postData: JSON.stringify(patch) });
    }
    return route.continue();
  });
}

const style = process.env.E2E_STYLE;
if (style) {
  if (!/^[a-z-]{1,32}$/.test(style)) throw new Error(`E2E_STYLE is not a style id: ${style}`);
  const launch = chromium.launch.bind(chromium);
  chromium.launch = async (options) => {
    const browser = await launch(options);
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async (opts) => {
      const ctx = await newContext(opts);
      await forceStyle(ctx, style);
      return ctx;
    };
    browser.newPage = async (opts) => (await browser.newContext(opts)).newPage();
    return browser;
  };
  console.log(`e2e style: ${style}`);
}
