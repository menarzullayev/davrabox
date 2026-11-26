// A tiny production-like front for e2e runs of a branch without touching the shared staging stack: serves
// apps/web/dist (SPA fallback to index.html) and forwards /api/* to an API process of the same branch.
//   API_URL=http://127.0.0.1:3100 PORT=5240 node serve-dist.mjs
// Optional DOWNLOADS_DIR serves /downloads/* from a folder (like Caddy does in production).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.DIST_DIR ?? join(here, '..', 'web', 'dist');
const downloads = process.env.DOWNLOADS_DIR ?? '';
const api = new URL(process.env.API_URL ?? 'http://127.0.0.1:3100');
const port = Number(process.env.PORT ?? 5240);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.apk': 'application/vnd.android.package-archive', '.exe': 'application/octet-stream' };

function file(res, path, req) {
  const st = statSync(path);
  const type = TYPES[extname(path)] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && type === 'video/mp4') {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : st.size - 1;
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${st.size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes' });
  createReadStream(path).pipe(res);
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname.startsWith('/api/')) {
    const p = request({ host: api.hostname, port: api.port, method: req.method, path: url.pathname.slice(4) + url.search, headers: { ...req.headers, host: api.host, 'x-forwarded-for': '127.0.0.1' } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    p.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(p);
    return;
  }
  if (url.pathname.startsWith('/downloads/')) {
    const f = downloads && normalize(join(downloads, url.pathname.slice('/downloads/'.length)));
    if (f && f.startsWith(normalize(downloads)) && existsSync(f) && statSync(f).isFile()) return file(res, f, req);
    res.writeHead(404);
    return res.end();
  }
  const f = normalize(join(root, decodeURIComponent(url.pathname)));
  if (f.startsWith(normalize(root)) && existsSync(f) && statSync(f).isFile()) return file(res, f, req);
  file(res, join(root, 'index.html'), req);
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}, /api -> ${api.origin}`));
