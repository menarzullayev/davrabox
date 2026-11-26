// Copies the MediaPipe WASM runtime from node_modules into public/mediapipe/wasm so background blur is served
// from our own origin (no CDN: required by the CSP and by the "no third-party data flow" rule).
// The segmentation model (public/mediapipe/selfie_segmenter.tflite, Apache-2.0, sha256 below) is committed.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_SHA256 = '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const model = join(root, 'public', 'mediapipe', 'selfie_segmenter.tflite');
const actual = createHash('sha256').update(readFileSync(model)).digest('hex');
if (actual !== MODEL_SHA256) throw new Error(`segmentation model hash mismatch: ${actual}`);

const require = createRequire(join(root, 'package.json'));
const pkgJson = require.resolve('@livekit/track-processors/package.json');
// The package does not export package.json; its main entry sits in the package root next to wasm/.
const entry = createRequire(pkgJson).resolve('@mediapipe/tasks-vision');
const src = join(dirname(entry), 'wasm');
const dst = join(root, 'public', 'mediapipe', 'wasm');
mkdirSync(dst, { recursive: true });
for (const f of readdirSync(src)) copyFileSync(join(src, f), join(dst, f));
console.log(`mediapipe assets ready (${readdirSync(dst).length} wasm files, model verified)`);

// Excalidraw (whiteboard, MIT): its hand-drawn fonts are served from our own origin too (window.EXCALIDRAW_ASSET_PATH =
// '/excalidraw/'; the CSP allows fonts only from 'self'). The 13 MB CJK fallback family (Xiaolai) is left out: the whiteboard
// falls back to a system font for those scripts.
const exPkg = createRequire(join(root, 'package.json')).resolve('@excalidraw/excalidraw');
const exFonts = join(dirname(exPkg), 'fonts'); // the resolved entry is dist/prod/index.js
const exDst = join(root, 'public', 'excalidraw', 'fonts');
let exCount = 0;
for (const family of readdirSync(exFonts)) {
  if (family === 'Xiaolai') continue;
  mkdirSync(join(exDst, family), { recursive: true });
  for (const f of readdirSync(join(exFonts, family))) {
    copyFileSync(join(exFonts, family, f), join(exDst, family, f));
    exCount++;
  }
}
console.log(`excalidraw fonts ready (${exCount} files)`);
