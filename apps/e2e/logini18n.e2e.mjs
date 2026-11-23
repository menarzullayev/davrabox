// End-to-end: the Keycloak login page speaks Uzbek, Russian and English (custom davrabox theme + built-in ru/en).
import { chromium } from 'playwright-core';
import { BASE } from './kc.mjs';

const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};
const browser = await chromium.launch({ channel: 'msedge' });
let exit = 0;
try {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US' });
  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await page.getByRole('button', { name: /Sign in|Kirish|Войти/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  // The language picker is a <select> whose option values are navigation URLs.
  const text = async (loc) => {
    const value = await page.evaluate((l) => {
      const o = Array.from(document.querySelectorAll('#login-select-toggle option')).find((x) => x.value.includes(`kc_locale=${l}`));
      return o ? o.value : null;
    }, loc);
    if (!value) throw new Error(`no language option for ${loc}`);
    await Promise.all([page.waitForNavigation(), page.selectOption('#login-select-toggle', value)]);
    await page.waitForSelector('#username');
    return (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  };
  const uz = await text('uz');
  check('Uzbek login page: labels and button in Uzbek', /Parol/.test(uz) && /Kirish/.test(uz) && /Foydalanuvchi nomi/.test(uz), uz.slice(0, 120));
  check('Uzbek login page: no leftover English "Password"/"Sign In"', !/\bPassword\b/.test(uz) && !/\bSign In\b/.test(uz));
  const ru = await text('ru');
  check('Russian login page', /Пароль/.test(ru) && /Имя пользователя/.test(ru) && !/\bPassword\b/.test(ru), ru.slice(0, 100));
  const en = await text('en');
  check('English login page', /Password/.test(en) && /Sign In/.test(en));
  // The language choice sticks for the error page too: a wrong password is reported in Uzbek.
  await text('uz');
  await page.fill('#username', 'user.demo');
  await page.fill('#password', 'definitely-wrong');
  await page.click('#kc-login');
  await page.waitForSelector('#input-error, .kc-feedback-text, [class*=alert]', { timeout: 15000 });
  const err = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  check('the error message after a wrong password is in Uzbek', /noto‘g‘ri/.test(err), err.slice(0, 120));
  await ctx.close();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  exit = 1;
} finally {
  await browser.close();
}
if (results.some((r) => !r)) exit = 1;
console.log(exit === 0 ? 'LOGIN I18N E2E: ALL PASSED' : 'LOGIN I18N E2E: FAILURES');
process.exit(exit);
