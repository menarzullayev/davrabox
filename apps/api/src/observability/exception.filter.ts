import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { orgIdOf, routeOf, stdoutSink, type LogSink, type ObsRequest } from './http-context.js';
import { acceptRequestId } from './request-id.js';
import { redactText } from './redact.js';

export interface FilterOptions {
  sink?: LogSink;
  /** Called for server errors (5xx) only, e.g. to forward them to the error tracker. */
  report?: (exception: unknown, ctx: { requestId: string; route: string }) => void;
}

const GENERIC: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  500: 'Internal server error',
  503: 'Service Unavailable',
};

// Wording that would echo the request path or the parser's view of the body back to the caller.
const LEAKY = /^Cannot (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) |\bJSON\b|position \d+|^Unexpected |^Expected /;

function describe(exception: unknown): { status: number; message: string; code?: string; disclaimer?: string } {
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const r = exception.getResponse();
    let message = exception.message;
    let code: string | undefined;
    if (typeof r === 'string') message = r;
    else if (r && typeof r === 'object') {
      const o = r as { message?: unknown; code?: unknown };
      if (typeof o.message === 'string') message = o.message;
      else if (Array.isArray(o.message)) message = o.message.filter((m) => typeof m === 'string').join('; ');
      if (typeof o.code === 'string') code = o.code;
    }
    if (LEAKY.test(message)) message = GENERIC[status] ?? 'Error';
    // The one detail a refusal may carry besides the code: the organization's join notice the person must accept (428).
    const d = (r as { disclaimer?: unknown } | null)?.disclaimer;
    const disclaimer = status === 428 && code === 'disclaimer' && typeof d === 'string' ? d.slice(0, 2000) : undefined;
    return { status, message: redactText(message), code, ...(disclaimer !== undefined ? { disclaimer } : {}) };
  }
  // Errors raised outside a controller (body parser): expose only the status, with fixed wording.
  const e = exception as { status?: unknown; statusCode?: unknown; expose?: unknown } | null;
  const s = typeof e?.status === 'number' ? e.status : typeof e?.statusCode === 'number' ? e.statusCode : 0;
  if (e?.expose === true && s >= 400 && s < 500) return { status: s, message: GENERIC[s] ?? 'Bad Request' };
  return { status: 500, message: GENERIC[500]! };
}

/**
 * Every error leaves the API as {statusCode, message, requestId} (plus the stable `code` some endpoints already return).
 * Stack traces and framework internals stay on the server: the stack goes to the log (redacted) and, for 5xx, to the tracker.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly sink: LogSink;
  constructor(private readonly opts: FilterOptions = {}) {
    this.sink = opts.sink ?? stdoutSink;
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<ObsRequest>();
    const res = http.getResponse<Response>();
    const requestId = req.requestId ?? acceptRequestId(undefined);
    const { status, message, code, disclaimer } = describe(exception);
    const route = routeOf(req);

    if (status >= 500) {
      const err = exception instanceof Error ? exception : new Error(String(exception));
      const line: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level: 'error',
        msg: 'unhandled_exception',
        requestId,
        method: req.method,
        route,
        status,
        err: { name: err.name, message: redactText(err.message), stack: redactText(err.stack ?? '') },
      };
      const orgId = orgIdOf(req);
      if (orgId) line.orgId = orgId;
      this.sink(JSON.stringify(line));
      try {
        this.opts.report?.(exception, { requestId, route });
      } catch {
        /* reporting must never change the answer */
      }
    }

    if (res.headersSent) return;
    const body: Record<string, unknown> = { statusCode: status, message };
    if (disclaimer !== undefined) body['disclaimer'] = disclaimer;
    if (code) body.code = code;
    body.requestId = requestId;
    res.status(status).json(body);
  }
}
