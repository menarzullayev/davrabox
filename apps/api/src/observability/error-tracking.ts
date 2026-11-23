import { redactText } from './redact.js';

type Sentry = typeof import('@sentry/node');

let sdk: Pick<Sentry, 'captureException'> | null = null;

/** Strips query string and fragment without a regex (URLs can carry codes and tokens). */
function stripUrl(u: unknown): unknown {
  if (typeof u !== 'string') return u;
  const cut = [u.indexOf('?'), u.indexOf('#')].filter((i) => i >= 0);
  return cut.length ? u.slice(0, Math.min(...cut)) : u;
}

/**
 * beforeSend hook: an event leaves the process with the exception type, stack frames, HTTP method and the URL without query or
 * fragment, and nothing else. Request bodies, headers, cookies, user data, host name, breadcrumbs, extra data and local
 * variables are dropped; messages are passed through the text redactor.
 */
export function scrubEvent<T extends object>(event: T): T {
  const e = event as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  delete e.server_name;
  delete e.user;
  delete e.extra;
  delete e.modules;
  delete e.breadcrumbs;
  if (typeof e.message === 'string') e.message = redactText(e.message);
  if (e.logentry && typeof e.logentry.message === 'string') e.logentry = { message: redactText(e.logentry.message) };
  if (typeof e.transaction === 'string') e.transaction = stripUrl(e.transaction);
  if (e.request && typeof e.request === 'object') {
    const r: Record<string, unknown> = {};
    if (e.request.method) r.method = e.request.method;
    if (e.request.url) r.url = stripUrl(e.request.url);
    e.request = r;
  }
  if (e.contexts && typeof e.contexts === 'object') {
    const keep: Record<string, unknown> = {};
    for (const k of ['trace', 'runtime']) if (e.contexts[k]) keep[k] = e.contexts[k];
    e.contexts = keep;
  }
  for (const v of e.exception?.values ?? []) {
    if (typeof v.value === 'string') v.value = redactText(v.value);
    for (const f of v.stacktrace?.frames ?? []) delete f.vars;
  }
  return event;
}

function validDsn(dsn: string): boolean {
  try {
    const u = new URL(dsn);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.username.length > 0 && /^\d+$/.test(u.pathname.split('/').pop() ?? '');
  } catch {
    return false;
  }
}

/**
 * Error tracking is off unless GLITCHTIP_DSN is set: with an empty value the SDK is not even loaded and nothing is sent.
 * Only error capture is enabled: no tracing, no breadcrumbs, no default integrations.
 */
export async function initErrorTracking(
  env: Record<string, string | undefined>,
  load: () => Promise<Sentry> = () => import('@sentry/node'),
): Promise<boolean> {
  const dsn = env.GLITCHTIP_DSN?.trim();
  if (!dsn) return false;
  if (!validDsn(dsn)) {
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'warn', msg: 'error_tracking_disabled', reason: 'invalid_dsn' })}\n`);
    return false;
  }
  const s = await load();
  s.initWithoutDefaultIntegrations({
    dsn,
    environment: env.GLITCHTIP_ENVIRONMENT || 'production',
    release: env.GLITCHTIP_RELEASE || undefined,
    maxBreadcrumbs: 0,
    beforeSend: scrubEvent,
    integrations: [s.onUncaughtExceptionIntegration(), s.onUnhandledRejectionIntegration(), s.linkedErrorsIntegration(), s.dedupeIntegration()],
  });
  sdk = s;
  return true;
}

/** Forwards a server error (5xx) to the tracker, tagged with the request id so it can be matched to the log line. */
export function captureServerError(err: unknown, ctx: { requestId: string; route: string }): void {
  sdk?.captureException(err, { tags: { request_id: ctx.requestId, route: ctx.route } });
}
