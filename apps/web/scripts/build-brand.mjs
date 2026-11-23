// Rasterises the brand SVGs (public/brand/*.svg, made by build-brand.py) to PNG and ICO with the system Edge through
// playwright-core (installed in apps/e2e), and renders the 1200x630 social preview.
//   node apps/web/scripts/build-brand.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { davraSvg } from '../src/brand/ornament.ts';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const brand = join(web, 'public', 'brand');
const { chromium } = createRequire(join(web, '..', 'e2e', 'package.json'))('playwright-core');
mkdirSync(brand, { recursive: true });

const svg = (name) => readFileSync(join(brand, name), 'utf8');
const browser = await chromium.launch({ channel: 'msedge' });
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function png(svgText, size, outName) {
  await page.setViewportSize({ width: size, height: size });
  const inner = svgText.replace(/width="[\d.]+" height="[\d.]+"/, 'width="100%" height="100%"');
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${inner}`);
  const buf = await page.screenshot({ omitBackground: true, type: 'png' });
  if (outName) writeFileSync(join(brand, outName), buf);
  return buf;
}

// Favicons and PWA/Apple/Electron icons.
const fav = svg('favicon.svg');
const icon = svg('app-icon.svg');
const maskable = svg('app-icon-maskable.svg');
const small = {};
for (const s of [16, 32, 48]) small[s] = await png(fav, s, `favicon-${s}.png`);
await png(maskable, 180, 'apple-touch-icon.png');
await png(icon, 192, 'icon-192.png');
await png(icon, 512, 'icon-512.png');
await png(maskable, 512, 'icon-maskable-512.png');
await png(icon, 1024, 'app-icon-1024.png');

// ICO with PNG-compressed images (Vista+): small sizes come from the heavier favicon artwork.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = [];
for (const s of sizes) {
  images.push({ s, data: await png(s <= 32 ? fav : icon, s, null) });
}
const head = Buffer.alloc(6);
head.writeUInt16LE(1, 2);
head.writeUInt16LE(images.length, 4);
let offset = 6 + 16 * images.length;
const dir = images.map(({ s, data }) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s === 256 ? 0 : s, 0);
  e.writeUInt8(s === 256 ? 0 : s, 1);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += data.length;
  return e;
});
writeFileSync(join(brand, 'app-icon.ico'), Buffer.concat([head, ...dir, ...images.map((i) => i.data)]));

// Social preview (1200x630).
const ornament = davraSvg({ rings: 4, petals: 14, rotation: 8 }, { size: 760, color: '#3dd6c8', hubColor: '#f4c24f', stroke: 1.1, fill: 0.07 });
const logo = svg('logo.svg').replace(/width="[\d.]+" height="[\d.]+"/, 'style="width:520px;height:auto"');
const font = pathToFileURL(join(web, 'public', 'fonts', 'onest-latin.woff2')).href;
const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:Onest;font-weight:400 700;src:url(${font}) format('woff2')}
html,body{margin:0;width:1200px;height:630px;overflow:hidden;font-family:Onest,sans-serif;color:#eef0fc}
body{background:radial-gradient(900px 600px at 80% 45%,#1b2150 0%,#0a0d21 70%);position:relative}
.orn{position:absolute;right:-230px;top:-65px;opacity:.55}
.copy{position:absolute;left:84px;top:0;bottom:0;display:flex;flex-direction:column;justify-content:center;gap:34px}
h1{margin:0;font-size:46px;line-height:1.18;font-weight:600;letter-spacing:-.01em;max-width:640px}
h1 span{color:#f4c24f}
p{margin:0;font-size:24px;color:#b4b9de}
</style><div class="orn">${ornament}</div><div class="copy">${logo}<h1>Xavfsiz. Mahalliy. <span>Sizning nazoratingizda.</span></h1><p>Korporativ videokonferensiya platformasi</p></div>`;
const dirTmp = mkdtempSync(join(tmpdir(), 'davra-brand-'));
const htmlPath = join(dirTmp, 'social.html');
writeFileSync(htmlPath, html);
await page.setViewportSize({ width: 1200, height: 630 });
await page.goto(pathToFileURL(htmlPath).href);
await page.evaluate(() => document.fonts.ready);
writeFileSync(join(brand, 'social-preview.png'), await page.screenshot({ type: 'png' }));

await browser.close();
console.log('brand rasters written to', brand);
