// Accessibility checks for the call screen on the lab (/lab/call):
//   1. axe-core (WCAG 2.0/2.1 A+AA + best-practice) on many states, both themes, three widths, three languages,
//      including every open popover and drawer. Exits 1 on any serious or critical violation.
//   2. Keyboard path of the control bar: roving tabindex, arrow keys, Home/End, popovers opening with focus inside and
//      returning focus on Escape, drawers closing with Escape, visible focus, 44 px targets, live-region wiring.
//   LAB_URL=http://127.0.0.1:5193 node call.a11y.mjs
import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright-core';

const base = process.env.LAB_URL ?? 'http://127.0.0.1:5193';
const browser = await chromium.launch({ channel: 'msedge' });
let blocking = 0;
const check = (name, ok, detail = '') => {
  if (!ok) blocking++;
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${detail ? ' :: ' + detail : ''}`);
};

async function open(query, { theme = 'dark', lang = 'uz', width = 1280, height = 720 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
  await ctx.addInitScript(([t, l]) => { localStorage.setItem('theme', t); localStorage.setItem('lang', l); }, [theme, lang]);
  const page = await ctx.newPage();
  await page.goto(`${base}/lab/call?ui=0&theme=${theme}&lang=${lang}&${query}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForSelector('.call');
  return { ctx, page };
}
const tid = (id) => `[data-testid="${id}"]`;

// ---- 1. axe -----------------------------------------------------------------------------------------------------
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];
async function axe(label, page) {
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  blocking += bad.length;
  console.log(`${bad.length === 0 ? 'PASSED' : 'FAILED'}  axe ${label}: ${r.violations.length} violations (${bad.length} serious/critical), ${r.passes.length} rules passed`);
  for (const v of r.violations) console.log(`   ${v.impact} ${v.id}: ${v.help} (${v.nodes.length} nodes) e.g. ${v.nodes[0]?.target?.join(' ')} | ${v.nodes[0]?.failureSummary?.split('\n')[1]?.trim() ?? ''}`);
}
const STATES = [
  ['davra n=8 host, hand, muted, co-host', 'n=8&speaker=3&hands=2&mute=4&cohost=5&react=6:%F0%9F%8E%89&requests=2&quality=poor&locked=1'],
  ['davra member, camera off, long name', 'n=6&role=member&camoff=2,3&long=1'],
  ['grid 13 with fallback hint', 'n=13&mode=davra'],
  ['speaker with screen share', 'n=7&mode=speaker&share=1'],
  ['davra with screen share', 'n=5&share=1'],
  ['connecting', 'connecting=1'],
  ['error and reconnecting', 'n=3&error=1&reconnecting=1'],
  ['chat drawer', 'n=4&panel=chat&unread=2'],
  ['people drawer (host)', 'n=6&panel=people&requests=1&hands=2'],
];
for (const theme of ['dark', 'light']) {
  for (const [width, height, lang] of [[1280, 720, 'uz'], [360, 740, 'ru'], [768, 1024, 'en']]) {
    for (const [name, q] of STATES) {
      const { ctx, page } = await open(q, { theme, lang, width, height });
      await axe(`${theme} ${width} ${lang} [${name}]`, page);
      await ctx.close();
    }
  }
}
// Open popovers (wide and compact).
for (const theme of ['dark', 'light']) {
  for (const [width, height, lang] of [[1280, 720, 'en'], [360, 740, 'uz']]) {
    for (const id of ['reactions', 'layout', 'more']) {
      const { ctx, page } = await open('n=6&speaker=2', { theme, lang, width, height });
      if ((await page.locator(tid(id)).count()) === 0) { await ctx.close(); continue; }
      await page.locator(tid(id)).click();
      await page.waitForTimeout(150);
      await axe(`${theme} ${width} ${lang} [popover ${id}]`, page);
      await ctx.close();
    }
  }
}

// ---- 2. keyboard path -------------------------------------------------------------------------------------------
{
  const { ctx, page } = await open('n=5&speaker=2&role=host&requests=1', { lang: 'en' });
  const order = ['mic', 'cam', 'share', 'hand', 'reactions', 'chat-toggle', 'people-toggle', 'layout', 'record', 'more', 'leave'];
  const active = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName);
  const stops = () => page.evaluate(() => Array.from(document.querySelectorAll('[role=toolbar] [data-roving]')).filter((b) => b.tabIndex === 0).map((b) => b.getAttribute('data-testid')));
  const inToolbar = () => page.evaluate(() => !!document.activeElement?.closest('[role=toolbar]'));

  check('the control bar is a labelled toolbar', (await page.locator('[role=toolbar]').getAttribute('aria-label')) !== null && (await page.locator('[role=toolbar]').getAttribute('aria-orientation')) === 'horizontal');
  check('roving tabindex: exactly one toolbar button is a tab stop', (await stops()).length === 1, JSON.stringify(await stops()));
  await page.locator(tid('mic')).focus();
  const seen = [await active()];
  for (let i = 1; i < order.length; i++) {
    await page.keyboard.press('ArrowRight');
    seen.push(await active());
  }
  check('ArrowRight visits every control in order', JSON.stringify(seen) === JSON.stringify(order), seen.join(','));
  await page.keyboard.press('ArrowRight');
  check('ArrowRight wraps from the last control to the first', (await active()) === 'mic');
  await page.keyboard.press('End');
  check('End jumps to the last control', (await active()) === 'leave');
  await page.keyboard.press('Home');
  check('Home jumps to the first control', (await active()) === 'mic');
  await page.keyboard.press('ArrowLeft');
  check('ArrowLeft wraps backwards', (await active()) === 'leave');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  check('after moving, the tab stop follows focus (still exactly one)', JSON.stringify(await stops()) === JSON.stringify(['cam']));
  await page.keyboard.press('Tab');
  check('Tab leaves the toolbar in one step', !(await inToolbar()));
  await page.keyboard.press('Shift+Tab');
  check('Shift+Tab returns to the remembered toolbar button', (await active()) === 'cam');

  // Focus is visible on every control (outline or ring) and each control is at least 44 px.
  let unseen = 0;
  let small = [];
  for (const id of order) {
    await page.locator(tid(id)).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const vis = await page.evaluate((i) => {
      const el = document.querySelector(`[data-testid="${i}"]`);
      const cs = getComputedStyle(el);
      return cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2;
    }, id);
    if (!vis) unseen++;
    const box = await page.locator(tid(id)).boundingBox();
    if (!box || box.width < 44 || box.height < 44) small.push(`${id}:${box?.width}x${box?.height}`);
  }
  check('every control shows a visible focus outline (>= 2 px)', unseen === 0, `${unseen} without`);
  check('every control is at least 44 x 44 px', small.length === 0, small.join(','));

  // Reactions popover: opens with focus inside, arrows move, Enter reacts, focus returns to the trigger.
  await page.locator(tid('reactions')).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  check('reactions popover opens with focus on the first emoji', (await active()) === 'react-👍');
  await page.keyboard.press('ArrowRight');
  check('arrow keys move between emoji', (await active()) === 'react-👏');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  check('choosing an emoji closes the popover, focus returns to the trigger and the reaction appears', (await active()) === 'reactions' && (await page.locator(tid('react-👍')).count()) === 0 && (await page.locator(`${tid('reaction')}`).first().textContent()) === '👏');

  // More panel: Escape closes and returns focus.
  await page.locator(tid('more')).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  check('More panel opens with focus inside it', await page.evaluate(() => !!document.activeElement?.closest('.dv-more')));
  await page.keyboard.press('Escape');
  check('Escape closes the More panel and returns focus to its button', (await active()) === 'more' && (await page.locator(tid('noise')).count()) === 0);

  // Layout popover: native radio group, arrows change the mode.
  await page.locator(tid('layout')).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  const group = await page.locator('[role=radiogroup]').getAttribute('aria-label');
  check('the layout switch is a named radio group', !!group);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(80);
  check('arrow keys switch the view', (await page.locator(tid('grid')).getAttribute('data-layout')) !== 'davra');
  await page.keyboard.press('Escape');
  check('Escape closes the layout panel and returns focus', (await active()) === 'layout');

  // Chat drawer: opens with the cursor in the message box, Escape closes it and returns focus to the toggle.
  await page.locator(tid('chat-toggle')).focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('opening the chat moves focus to the message box', (await active()) === 'chat-input');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  check('Escape closes the chat and returns focus to the chat button', (await active()) === 'chat-toggle' && (await page.locator(tid('chat-panel')).count()) === 0);

  // Landmarks and live region.
  check('the polite live region exists', (await page.locator('[role=status][aria-live=polite]').count()) >= 1);
  check('the stage is a labelled group and every tile is a labelled group', (await page.locator('.dv-stage[role=group][aria-label]').count()) === 1 && (await page.locator('.tile[role=group]:not([aria-label])').count()) === 0);
  check('the page has one h1 (the meeting title)', (await page.locator('h1').count()) === 1);
  await ctx.close();
}
// Live region content: speaker, hand and join announcements arrive debounced.
{
  const { ctx, page } = await open('n=4&speaker=1&sim=1&tick=700', { lang: 'en' });
  await page.waitForTimeout(6000);
  const texts = [];
  for (let i = 0; i < 12; i++) {
    texts.push(await page.locator(tid('call-live')).innerText());
    await page.waitForTimeout(500);
  }
  const spoken = texts.filter((t, i) => t && t !== texts[i - 1]);
  check('speaker changes (every 0.7 s) produce few, calm announcements', spoken.length <= 4, `${spoken.length} distinct in 6 s: ${spoken.join(' | ')}`);
  await ctx.close();
}
await browser.close();
console.log(blocking === 0 ? 'CALL A11Y: ALL PASSED' : `CALL A11Y: ${blocking} BLOCKING`);
process.exit(blocking === 0 ? 0 : 1);
