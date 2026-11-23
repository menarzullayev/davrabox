// Performance of the call screen on the lab (/lab/call) with live <video> tiles (one animated canvas stream attached to
// every tile) and the speaker changing every second. Measures through CDP and in-page observers:
//   frames per second and frame-time percentiles (requestAnimationFrame deltas), long tasks (>50 ms), layout and style
//   recalculation counts per second (CDP Performance metrics), script time per second.
// Runs each scenario at 1x and with 4x CPU throttling (a stand-in for a mid laptop).
//   LAB_URL=http://127.0.0.1:5193 node call.perf.mjs [seconds]
import { chromium } from 'playwright-core';

const base = process.env.LAB_URL ?? 'http://127.0.0.1:5193';
const SECONDS = Number(process.argv[2] ?? 15);
const browser = await chromium.launch({ channel: 'msedge', args: ['--autoplay-policy=no-user-gesture-required', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'] });

const SCENARIOS = [
  ['Davra n=12, speaker changes every 1 s', 'n=12&mode=davra&sim=1&tick=1000'],
  ['Davra n=12, speaker changes every 300 ms (stress)', 'n=12&mode=davra&sim=1&tick=300'],
  ['Davra n=12, static (baseline)', 'n=12&mode=davra'],
  ['Grid n=12, speaker changes every 1 s', 'n=12&mode=gallery&sim=1&tick=1000'],
  ['Speaker view n=12, speaker changes every 1 s', 'n=12&mode=speaker&sim=1&tick=1000'],
  ['Grid n=30 (13+ fallback), static', 'n=30&mode=davra'],
];

const pct = (a, p) => a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0;

async function run(label, query, throttle) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
  await ctx.addInitScript(() => { localStorage.setItem('theme', 'dark'); localStorage.setItem('lang', 'en'); });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  await page.goto(`${base}/lab/call?ui=0&${query}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.tile video');
  await page.waitForTimeout(1500); // let the streams start
  await page.evaluate(() => {
    window.__frames = [];
    window.__long = [];
    let last = performance.now();
    const loop = (t) => { window.__frames.push(t - last); last = t; window.__raf = requestAnimationFrame(loop); };
    window.__raf = requestAnimationFrame(loop);
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ entryTypes: ['longtask'] });
    } catch { /* not supported */ }
  });
  const m0 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  await page.waitForTimeout(SECONDS * 1000);
  const m1 = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  const { frames, long } = await page.evaluate(() => { cancelAnimationFrame(window.__raf); return { frames: window.__frames.slice(2), long: window.__long }; });
  const videos = await page.evaluate(() => Array.from(document.querySelectorAll('.tile video')).filter((v) => !v.paused && v.readyState >= 2).length);
  const tiles = await page.evaluate(() => document.querySelectorAll('.tile').length);
  const dt = m1.Timestamp - m0.Timestamp;
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length;
  const res = {
    fps: +(1000 / avg).toFixed(1),
    p95: +pct(frames, 95).toFixed(1),
    p99: +pct(frames, 99).toFixed(1),
    over25: frames.filter((f) => f > 25).length,
    over50: frames.filter((f) => f > 50).length,
    frames: frames.length,
    longTasks: long.length,
    longMax: +(Math.max(0, ...long)).toFixed(0),
    layoutsPerSec: +((m1.LayoutCount - m0.LayoutCount) / dt).toFixed(2),
    stylesPerSec: +((m1.RecalcStyleCount - m0.RecalcStyleCount) / dt).toFixed(2),
    layoutMsPerSec: +(((m1.LayoutDuration - m0.LayoutDuration) / dt) * 1000).toFixed(2),
    scriptMsPerSec: +(((m1.ScriptDuration - m0.ScriptDuration) / dt) * 1000).toFixed(1),
    taskMsPerSec: +(((m1.TaskDuration - m0.TaskDuration) / dt) * 1000).toFixed(0),
    videos: `${videos}/${tiles}`,
  };
  console.log(`${label} @${throttle}x CPU`.padEnd(66), JSON.stringify(res));
  await ctx.close();
  return res;
}

console.log(`window ${SECONDS}s per run, viewport 1440x900, motion enabled`);
for (const throttle of [1, 4]) for (const [label, q] of SCENARIOS) await run(label, q, throttle);
await browser.close();
