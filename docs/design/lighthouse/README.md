# Lighthouse results for the landing page (2026-11-24)

Lighthouse 12 (CLI, Edge headless), production build served by `vite preview` on a local port; categories: performance, accessibility, best practices, SEO.

| Device | Performance | Accessibility | Best practices | SEO | LCP | TBT | CLS |
|---|---|---|---|---|---|---|---|
| Desktop | 100 | 100 | 100 | 100 | 0.5 s | 0 ms | 0 |
| Mobile (simulated slow 4G) | 98 | 100 | 100 | 100 | 2.3 s | 0 ms | 0 |

Before the fixes (public host served by the Vite dev server): accessibility 100, best practices 96 (a React warning about `fetchPriority`), SEO 92 (no real robots.txt), agentic browsing 67 (no llms.txt), LCP 1.75 s.

Fixes: real `robots.txt` and `llms.txt`; the hero image is a `<picture>` with WebP at 640 and 1280 px (10 and 27 KB instead of one 62 KB JPEG) and is preloaded early by `theme-init.js`; the lowercase `fetchpriority` attribute.

Remaining mobile findings (not fixed): render-blocking CSS and `theme-init.js` (about 150 ms on the simulated network) and the extra round trip for the lazily loaded landing chunk.
Reproduce: `pnpm --filter @davrabox/web build`, `pnpm --filter @davrabox/web exec vite preview --port 4173`, then `npx lighthouse@12 http://127.0.0.1:4173/ [--preset=desktop]`.
The public host currently runs the Vite dev server, so its numbers differ from a production build.
