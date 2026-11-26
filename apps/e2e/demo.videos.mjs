// Records the silent demo clips of the landing page (owner decision 7 of 2026-11-26) from the labs: synthetic
// participants (call lab canvases) and Chromium's fake camera pattern, never a real face. One clip per demo and
// language: apps/web/public/landing/demo/<id>-<lang>.mp4 (H.264, 960x540, no audio) + <id>-<lang>.webp poster.
//
// Regenerate whenever the UI changes (see docs/demo-videos.md):
//   cd apps/web && VITE_CALL_LAB=1 VITE_HOME_LAB=1 pnpm exec vite build --outDir dist-lab && pnpm exec vite preview --outDir dist-lab --port 5231 --strictPort
//   cd apps/e2e && LAB_URL=http://127.0.0.1:5231 node demo.videos.mjs           (needs ffmpeg with libx264 and libwebp on PATH)
// Options: DEMO_LANGS=uz,ru,en  DEMO_IDS=join,waiting,share,admin  DEMO_THEME=dark
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const base = process.env.LAB_URL ?? 'http://127.0.0.1:5231';
const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.DEMO_OUT ?? join(here, '..', 'web', 'public', 'landing', 'demo');
const LANGS = (process.env.DEMO_LANGS ?? 'uz,ru,en').split(',');
const IDS = (process.env.DEMO_IDS ?? 'join,waiting,share,admin').split(',');
const THEME = process.env.DEMO_THEME ?? 'dark';
const SIZE = { width: 1280, height: 720 };
mkdirSync(out, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lab = (path, lang, extra = '') => `${base}${path}${path.includes('?') ? '&' : '?'}lang=${lang}&theme=${THEME}${extra}`;

/** One scene = one page = one recorded file. Returns the file and the seconds to cut before the content was ready. */
async function scene(ctx, url, act) {
  const t0 = Date.now();
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await wait(400);
  const skip = (Date.now() - t0) / 1000;
  await act(page);
  const video = page.video();
  await page.close();
  return { file: await video.path(), skip };
}

async function typeSlowly(page, selector, text) {
  await page.click(selector);
  for (const ch of text) {
    await page.keyboard.type(ch);
    await wait(90);
  }
}

const SCENES = {
  // Landing: type the code -> pre-join with the fake camera -> in the call.
  join: (lang) => [
    [`${base}/?lang=${lang}`, async (p) => {
      await p.locator('[data-testid=landing-join] input').scrollIntoViewIfNeeded();
      await wait(300);
      await typeSlowly(p, '[data-testid=landing-join] input', '308 1234 5678');
      await wait(700);
    }],
    [lab('/lab/home?screen=prejoin', lang), async (p) => {
      await wait(1200);
      await p.click('[data-testid=prejoin-mic]');
      await wait(500);
      await p.click('[data-testid=prejoin-mic]');
      await wait(600);
      await p.hover('[data-testid=prejoin-join]');
      await wait(500);
    }],
    [lab('/lab/call?ui=0&n=6&speaker=2&tick=900', lang), async () => wait(3000)],
  ],
  // A guest waits; the host admits two people from the requests tray.
  waiting: (lang) => [
    [lab('/lab/home?screen=waiting', lang), async () => wait(2200)],
    [lab('/lab/call?ui=0&n=4&requests=2&speaker=1', lang), async (p) => {
      await wait(1000);
      for (let i = 0; i < 2; i++) {
        const btn = p.locator('[data-testid=join-request] .dx-btn[data-variant=primary]').first();
        await btn.hover();
        await wait(500);
        await btn.click();
        await wait(900);
      }
      await wait(800);
    }],
  ],
  // The share button, then a participant presenting.
  share: (lang) => [
    [lab('/lab/call?ui=0&n=5&speaker=3', lang), async (p) => {
      await wait(900);
      await p.hover('[data-testid=share]');
      await wait(700);
      await p.click('[data-testid=share]');
      await wait(1200);
    }],
    [lab('/lab/call?ui=0&n=5&share=1&speaker=2', lang), async () => wait(3000)],
  ],
  // Admin console: overview -> users -> policies -> audit log.
  admin: (lang) => [
    [lab('/lab/admin', lang), async (p) => {
      await wait(1200);
      for (const i of [1, 3, 4]) {
        const b = p.locator('.adm-nav button').nth(i);
        await b.hover();
        await wait(300);
        await b.click();
        await wait(1500);
      }
    }],
  ],
};

function encode(parts, dest, poster) {
  const tmp = mkdtempSync(join(tmpdir(), 'davra-demo-'));
  try {
    const trimmed = parts.map((p, i) => {
      const f = join(tmp, `p${i}.mp4`);
      execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', p.skip.toFixed(2), '-i', p.file, '-vf', 'scale=960:540:flags=lanczos,fps=24', '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-pix_fmt', 'yuv420p', f]);
      return f;
    });
    const list = join(tmp, 'list.txt');
    writeFileSync(list, trimmed.map((f) => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', dest]);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1.2', '-i', dest, '-frames:v', '1', '-c:v', 'libwebp', '-quality', '72', poster]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const raw = mkdtempSync(join(tmpdir(), 'davra-demo-raw-'));
// The pre-join camera: a soft synthetic gradient with a neutral head-and-shoulders silhouette (no real face), fed to
// Chromium as its fake capture device instead of the default green test pattern.
const camera = join(raw, 'camera.y4m');
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'gradients=s=640x360:r=25:d=6:speed=0.012:c0=0x2b2d6e:c1=0x1d7f86:c2=0x6a3d8f:nb_colors=3',
  '-vf', "drawbox=x=0:y=0:w=640:h=360:color=black@0.12:t=fill,geq=lum='lum(X,Y)+if(lt(hypot(X-320,Y-150),62),46,0)+if(lt(hypot((X-320)/1.9,Y-330),70),46,0)':cb='cb(X,Y)':cr='cr(X,Y)'",
  '-pix_fmt', 'yuv420p', camera,
]);
const browser = await chromium.launch({
  channel: process.env.DEMO_CHANNEL ?? 'msedge',
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${camera}`, '--autoplay-policy=no-user-gesture-required'],
});
try {
  for (const lang of LANGS) {
    for (const id of IDS) {
      const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 1, recordVideo: { dir: raw, size: SIZE }, permissions: ['camera', 'microphone'] });
      await ctx.addInitScript(([t, l]) => {
        localStorage.setItem('theme', t);
        localStorage.setItem('lang', l);
      }, [THEME, lang]);
      const parts = [];
      for (const [url, act] of SCENES[id](lang)) parts.push(await scene(ctx, url, act));
      await ctx.close();
      const dest = join(out, `${id}-${lang}.mp4`);
      encode(parts, dest, join(out, `${id}-${lang}.webp`));
      console.log(`${id}-${lang}: ${(statSync(dest).size / 1024).toFixed(0)} KB`);
    }
  }
} finally {
  await browser.close();
  for (const f of readdirSync(raw)) rmSync(join(raw, f), { force: true });
  rmSync(raw, { recursive: true, force: true });
}
