// End-to-end: "Firewall mode" (relay-only ICE). Verifies that LiveKit hands out TURN credentials and that our TURN server
// allocates a relay address on the published port range. Media over the relay is reported as BLOCKED (see below).
import { chromium } from 'playwright-core';
import { BASE, createUser } from './kc.mjs';

const results = [];
const check = (name, ok, d = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASSED' : 'FAILED'}  ${name}${d ? ' :: ' + d : ''}`);
};
const PASSWORD = process.env.DEMO_USER_PASSWORD;
if (!PASSWORD) throw new Error('DEMO_USER_PASSWORD is required (source scripts/devenv.sh)');
const browser = await chromium.launch({
  channel: 'msedge',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});

async function open(username, password, relay) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', permissions: ['camera', 'microphone'] });
  // Keep every RTCPeerConnection so the selected candidate pair can be inspected later.
  await ctx.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.__pcs = [];
    window.RTCPeerConnection = function (...a) {
      const pc = new Native(...a);
      window.__pcs.push(pc);
      return pc;
    };
    window.RTCPeerConnection.prototype = Native.prototype;
  });
  const page = await ctx.newPage();
  await page.goto(BASE + '/app');
  await page.getByRole('button', { name: /^(Sign in|Kirish|Войти)$/ }).click();
  await page.waitForSelector('#username', { timeout: 30000 });
  await page.fill('#username', username);
  await page.fill('#password', password);
  await page.click('#kc-login');
  await page.waitForSelector('.home', { timeout: 30000 });
  if (relay) {
    await page.getByTestId('settings').click();
    await page.getByTestId('relay-mode').check();
    check('the firewall mode choice is remembered in the browser', (await page.evaluate(() => localStorage.getItem('relayMode'))) === '1');
  }
  return { ctx, page };
}
const joinByCode = async (page, code) => {
  const form = page.locator('[data-testid=join-form]');
  await form.locator('input[inputmode=numeric]').fill(code);
  await form.getByRole('button').click();
  await page.waitForSelector('.call', { timeout: 30000 });
};
// Types of the local candidates of every selected (nominated, succeeded) pair across the page's peer connections.
const selectedTypes = (page) =>
  page.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs) {
      const stats = await pc.getStats();
      const byId = new Map();
      stats.forEach((r) => byId.set(r.id, r));
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) {
          const l = byId.get(r.localCandidateId);
          if (l) out.push(l.candidateType);
        }
      });
    }
    return out;
  });

const b = await createUser();
let exit = 0;
try {
  const host = await open('user.demo', PASSWORD, true);
  const pb = await open(b.username, b.password, true);
  const title = `Relay ${Date.now()}`;
  await host.page.getByTestId('new-meeting').click();
  await host.page.fill('[data-testid=meeting-title]', title);
  await host.page.getByTestId('waiting-room').uncheck();
  await host.page.getByRole('button', { name: /Create|Yaratish|Создать/ }).click();
  await host.page.waitForSelector(`li:has-text("${title}")`);
  const code = (await host.page.locator(`li:has-text("${title}") .code`).innerText()).replace(/\D/g, '');
  await joinByCode(host.page, code);
  await joinByCode(pb.page, code);

  await host.page.waitForTimeout(8000);
  // The client received TURN credentials from LiveKit and the TURN server really allocated a relay address for it.
  const relays = await host.page.evaluate(async () => {
    const out = [];
    for (const pc of window.__pcs) {
      const st = await pc.getStats();
      st.forEach((r) => {
        if (r.type === 'local-candidate' && r.candidateType === 'relay') out.push({ address: r.address || r.ip, port: r.port });
      });
    }
    return out;
  });
  const lan = process.env.LAN_IP;
  check(
    'in firewall mode the browser gets an authenticated relay allocation from our TURN server (relay range 52000-52019)',
    relays.length > 0 && relays.every((r) => r.address === lan && r.port >= 52000 && r.port <= 52019),
    JSON.stringify(relays),
  );
  // BLOCKED, not passed: media over the relay cannot complete in this environment. TURN sits in a Docker Desktop
  // container whose relay must reach the SFU on its own published address (hairpin NAT), which Docker Desktop does not do.
  // It needs a Linux host with the media ports reachable (see docs/HELD.md).
  console.log('BLOCKED  media flowing through the relay: needs a Linux/public-IP deployment (Docker Desktop NAT hairpin)');

  for (const x of [host, pb]) await x.ctx.close();
} catch (e) {
  console.log('FAILED  unexpected error :: ' + String(e).split('\n')[0]);
  exit = 1;
} finally {
  await browser.close();
  await b.cleanup();
}
if (results.some((r) => !r)) exit = 1;
console.log(exit === 0 ? 'TURN E2E: ALL PASSED' : 'TURN E2E: FAILURES');
process.exit(exit);
