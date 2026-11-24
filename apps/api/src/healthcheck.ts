/**
 * Container healthcheck. The API image is distroless (no shell, no curl/wget), so Docker runs this script instead:
 *   node dist/healthcheck.js [/readyz]
 * Exit 0 when http://127.0.0.1:$API_PORT<path> answers 200 within HEALTHCHECK_TIMEOUT_MS (default 3000), otherwise 1.
 * Only the loopback interface and a plain absolute path are ever requested.
 */
import http from 'node:http';

const path = process.argv[2] ?? '/healthz';
const port = Number(process.env['API_PORT'] ?? '3000');
const timeoutMs = Number(process.env['HEALTHCHECK_TIMEOUT_MS'] ?? '3000');

if (!/^\/[A-Za-z0-9/_-]*$/.test(path) || path.startsWith('//') || !Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);

const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs, agent: false }, (res) => {
  res.resume();
  process.exit(res.statusCode === 200 ? 0 : 1);
});
req.on('timeout', () => {
  req.destroy();
  process.exit(1);
});
req.on('error', () => process.exit(1));
// Hard stop even if neither event fires (a trickling peer keeps the socket "active").
setTimeout(() => process.exit(1), timeoutMs + 500).unref();
