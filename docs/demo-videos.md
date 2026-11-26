# Landing demo clips

Owner decision 7 of `2026-11-26-landing-vs-zoom.md`: 3-4 short silent looping clips recorded automatically, with
synthetic media only (call-lab canvases and a generated camera picture, never a real face), lazy-loaded in the
"See it in action" cards of the landing page.

| Clip | Scenes |
|---|---|
| `join` | landing: the meeting code is typed -> pre-join with the synthetic camera -> the call (davra layout) |
| `waiting` | a guest's waiting screen -> the host admits two people from the requests tray |
| `share` | the share button in the call -> a participant presenting |
| `admin` | admin console (`/lab/admin`, fake data): overview -> users -> policies -> audit log |

Files: `apps/web/public/landing/demo/<clip>-<lang>.mp4` (H.264, 960x540, 24 fps, no audio track, `+faststart`) and
`<clip>-<lang>.webp` posters, for `uz`, `ru` and `en` (the clips show interface text).

The page sets no `src` until a card is near the viewport (`preload="none"`), plays only while visible, never autoplays
for `prefers-reduced-motion`, and every clip has a pause button.

## Regenerate (whenever the UI in a clip changes)

```sh
cd apps/web
VITE_CALL_LAB=1 VITE_HOME_LAB=1 pnpm exec vite build --outDir dist-lab
pnpm exec vite preview --outDir dist-lab --port 5231 --strictPort --host 127.0.0.1
# second terminal
cd apps/e2e
LAB_URL=http://127.0.0.1:5231 node demo.videos.mjs     # DEMO_LANGS=en DEMO_IDS=join for one clip
```

Needs Microsoft Edge (or `DEMO_CHANNEL=chrome`) and `ffmpeg` with `libx264` and `libwebp` on PATH. The script writes
the files in place; commit them with the UI change.
