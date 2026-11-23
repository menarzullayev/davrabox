import type { NextFunction, Request, Response } from 'express';
import { httpRequestDuration } from '../metrics.js';
import { orgIdOf, routeOf, stdoutSink, type LogSink, type ObsRequest } from './http-context.js';
import { acceptRequestId } from './request-id.js';

/**
 * One JSON line per request, written when the response is done. Only an allow-list of fields is ever logged: no headers,
 * query string, path parameters, body, cookies or tokens can reach the log by construction.
 */
export function createRequestLogger(opts: { sink?: LogSink } = {}) {
  const sink = opts.sink ?? stdoutSink;
  return (req: Request, res: Response, next: NextFunction): void => {
    const r = req as ObsRequest;
    const id = acceptRequestId(req.headers['x-request-id']);
    r.requestId = id;
    res.setHeader('X-Request-Id', id);
    const start = process.hrtime.bigint();
    let done = false;
    res.on('close', () => {
      if (done) return;
      done = true;
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const route = routeOf(r);
      const status = res.statusCode;
      httpRequestDuration.observe({ method: req.method, route, status: String(status) }, ms / 1000);
      const line: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        msg: 'request',
        requestId: id,
        method: req.method,
        route,
        status,
        latencyMs: Math.round(ms * 10) / 10,
      };
      const orgId = orgIdOf(r);
      if (orgId) line.orgId = orgId;
      if (r.user?.userId) line.userId = r.user.userId;
      sink(JSON.stringify(line));
    });
    next();
  };
}
