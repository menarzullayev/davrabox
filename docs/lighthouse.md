# Lighthouse

Owner decision of 2026-11-26 (landing package): the production build of the landing page must stay within 5 points of
the build before the package, in every Lighthouse category.

## How it is measured

```sh
pnpm --filter @davrabox/web build                       # once for each build being compared
DIST_DIR=<base>/apps/web/dist PORT=5251 node apps/e2e/serve-dist.mjs
DIST_DIR=<new>/apps/web/dist  PORT=5252 node apps/e2e/serve-dist.mjs
cd apps/e2e && node lh-pair.mjs <outDir> base=http://127.0.0.1:5251/ new=http://127.0.0.1:5252/
```

`lh-pair.mjs` starts one headless Microsoft Edge with a debugging port and runs `lighthouse@12` against it: mobile
(default simulated throttling) and `--preset=desktop`, two runs each, categories performance, accessibility, best
practices and SEO. `serve-dist.mjs` serves the files without compression, so transfer sizes are larger than behind
Caddy in production; both builds are measured the same way.

## 2026-11-26: landing package (PR #103)

Base: `main` before the package. New: branch `feat/landing-package`. Same machine, same session, mean of two runs.

| Page | Form | Performance | Accessibility | Best practices | SEO | LCP |
|---|---|---|---|---|---|---|
| `/` base | mobile | 77.5 | 100 | 100 | 92 | 4.24 s |
| `/` new | mobile | 74 | 100 | 100 | 92 | 5.12 s |
| `/` base | desktop | 99 | 100 | 100 | 92 | 0.85 s |
| `/` new | desktop | 98.5 | 100 | 100 | 92 | 0.99 s |
| `/help` new | mobile | 74 | 100 | 100 | 100 | 4.81 s |
| `/help` new | desktop | 99 | 100 | 100 | 100 | 0.97 s |

Result: within 5 points in every category (largest change: mobile performance of `/`, -3.5). Total blocking time
stayed under 20 ms and layout shift at 0. Before the package `/help` did not exist (the address opened the app shell),
so it has no base row.

The demo clips load no bytes until their card nears the viewport (`preload="none"`, no `src` before that), and the
help assistant's window is a separate chunk loaded on the first click.
