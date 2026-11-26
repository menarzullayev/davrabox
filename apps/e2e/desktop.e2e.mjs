// End-to-end: the Electron desktop shell, started for real against the public HTTPS domain (valid certificate).
//  - the page runs sandboxed with no Node.js; the preload bridge is the fixed minimal one
//  - navigation away from the app origin is blocked, window.open is denied, other permissions are denied
//  - a user signs in through Keycloak inside the app, joins a meeting and camera/microphone work
// The packaged executable's fuses are checked separately (see docs/PROGRESS.md); Playwright needs the debug port that
// the production fuses deliberately disable, so this test drives the same code via `electron .`.
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUser } from './kc.mjs';

const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};
const PASSWORD = process.env.DEMO_USER_PASSWORD;
if (!PASSWORD) throw new Error('DEMO_USER_PASSWORD is required (source scripts/devenv.sh)');
const APP_URL = process.env.DESKTOP_E2E_URL ?? 'https://davrabox.bugvector.uz';
const desktopDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'desktop');
const electronPath = createRequire(join(desktopDir, 'package.json'))('electron');

const user = await createUser();
let app;
let exit = 0;
try {
  app = await electron.launch({
    executablePath: electronPath,
    args: [desktopDir, '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    env: { ...process.env, DAVRABOX_URL: APP_URL },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: /^(Sign in|Kirish|Войти)$/ }).waitFor({ timeout: 30000 });
  check('the shell loads the web client from the app origin', new URL(page.url()).origin === new URL(APP_URL).origin);

  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const wp = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { contextIsolation: wp.contextIsolation, sandbox: wp.sandbox, nodeIntegration: wp.nodeIntegration, webSecurity: wp.webSecurity, webviewTag: wp.webviewTag };
  });
  check('contextIsolation and sandbox are on, nodeIntegration and webview are off', prefs.contextIsolation === true && prefs.sandbox === true && prefs.nodeIntegration === false && prefs.webviewTag === false && prefs.webSecurity === true, JSON.stringify(prefs));

  const bridge = await page.evaluate(() => ({
    require: typeof require,
    process: typeof process,
    bridge: window.davraDesktop ? Object.keys(window.davraDesktop).sort().join(',') : null,
    ipc: typeof window.ipcRenderer,
  }));
  check('the page has no Node.js; only the fixed bridge {isDesktop, platform, setTheme} exists', bridge.require === 'undefined' && bridge.process === 'undefined' && bridge.ipc === 'undefined' && bridge.bridge === 'isDesktop,platform,setTheme', JSON.stringify(bridge));

  // Replace shell.openExternal in the main process so the test records the hand-over instead of opening a real browser.
  await app.evaluate(({ shell }) => {
    globalThis.__opened = [];
    shell.openExternal = async (u) => void globalThis.__opened.push(u);
  });
  await page.evaluate(() => {
    location.href = 'https://example.org/';
  });
  await page.waitForTimeout(2500);
  check('navigating away from the app origin is blocked', new URL(page.url()).origin === new URL(APP_URL).origin, page.url());

  const before = app.windows().length;
  await page.evaluate(() => window.open('https://example.org/', '_blank'));
  await page.waitForTimeout(1500);
  check('window.open does not create a new in-app window', app.windows().length === before);

  const opened = await app.evaluate(() => globalThis.__opened);
  check('safe external links are handed to the system browser, not shown in the app', opened.includes('https://example.org/') && opened.length === 2, JSON.stringify(opened));

  const geo = await page.evaluate(
    () => new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('granted'), (e) => resolve(e.code === 1 ? 'denied' : `error ${e.code}`), { timeout: 5000 })),
  );
  check('permissions other than camera, microphone and screen are denied (geolocation)', geo === 'denied', String(geo));

  if (process.env.E2E_DEBUG) console.log('page now:', page.url(), JSON.stringify(await page.locator('button').allInnerTexts()));
  // Sign in inside the app and join a meeting.
  // The refused navigation above leaves Playwright waiting for a navigation that never completes: reload from the main process.
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url), `${APP_URL.replace(/\/+$/, '')}/app`);
  await page.getByRole('button', { name: /^(Sign in|Kirish|Войти)$/ }).waitFor({ timeout: 30000 });
  // noWaitAfter: in Electron the click starts a cross-document navigation that Playwright would otherwise wait on.
  await page.getByRole('button', { name: /^(Sign in|Kirish|Войти)$/ }).click({ noWaitAfter: true });
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', user.username);
  await page.fill('#password', user.password);
  await page.click('#kc-login', { noWaitAfter: true });
  await page.waitForSelector('.home', { timeout: 30000 });
  check('signing in through Keycloak works inside the desktop app', true);

  const title = `Desktop ${Date.now()}`;
  await page.getByTestId('new-meeting').click();
  await page.fill('[data-testid=meeting-title]', title);
  await page.getByTestId('waiting-room').uncheck();
  await page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await page.waitForSelector(`li:has-text("${title}")`);
  const code = (await page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  await page.locator('[data-testid=join-form]').locator('input[inputmode=numeric]').fill(code);
  await page.locator('[data-testid=join-form]').getByRole('button').click();
  await page.waitForSelector('.call', { timeout: 30000 });
  const live = await page
    .waitForFunction(() => { const v = document.querySelector('.tile[data-identity] video'); return !!v && v.videoWidth > 0 && !v.paused; }, null, { timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  check('inside the desktop app the camera and microphone work and the call is live', live);
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e.message || e).split('\n').slice(0, 10).join(' | '));
  exit = 1;
} finally {
  await app?.close().catch(() => undefined);
  await user.cleanup();
}
if (results.some((r) => !r)) exit = 1;
console.log(exit === 0 ? 'DESKTOP E2E: ALL PASSED' : 'DESKTOP E2E: FAILURES');
process.exit(exit);
