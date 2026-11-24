// Browser error tracking against GlitchTip (Sentry-compatible). Off unless the deployment hands out a DSN at runtime through
// /runtime-config.json (written by the web container from GLITCHTIP_WEB_DSN). The SDK is a lazy chunk: with no DSN nothing is
// downloaded and nothing is sent. Only error capture is on: no tracing, no session replay, no breadcrumbs, no PII.

export interface WebSdk {
  init(options: Record<string, unknown>): unknown;
  globalHandlersIntegration(): unknown;
  dedupeIntegration(): unknown;
  linkedErrorsIntegration(): unknown;
  browserApiErrorsIntegration(): unknown;
}

/** Cuts at the first '?' or '#': the query string can hold meeting codes, and the fragment holds the E2EE meeting key. */
function bare(u: unknown): unknown {
  if (typeof u !== 'string') return u;
  const cut = [u.indexOf('?'), u.indexOf('#')].filter((i) => i >= 0);
  return cut.length ? u.slice(0, Math.min(...cut)) : u;
}

const RULES: Array<[RegExp, string]> = [
  [/Bearer[ \t]+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  [/(:\/\/)[^\s/:@]+:[^\s/@]+@/g, '$1[redacted]@'],
  [/\b(password|passwd|passcode|secret|token|api[_-]?key)(["']?[ \t]*[:=][ \t]*["']?)[^\s"',;&]+/gi, '$1$2[redacted]'],
];
function redact(s: string): string {
  let out = s.length > 8000 ? `${s.slice(0, 8000)}...[truncated]` : s;
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

/** beforeSend: an event keeps the exception type, stack frames and the page URL without query or fragment, nothing else. */
export function scrubBrowserEvent<T extends object>(event: T): T {
  const e = event as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  delete e.user;
  delete e.extra;
  delete e.breadcrumbs;
  delete e.server_name;
  if (typeof e.message === 'string') e.message = redact(e.message);
  if (typeof e.transaction === 'string') e.transaction = bare(e.transaction);
  e.request = e.request?.url ? { url: bare(e.request.url) } : undefined;
  if (e.contexts && typeof e.contexts === 'object') {
    e.contexts = e.contexts.trace ? { trace: e.contexts.trace } : {};
  }
  for (const v of e.exception?.values ?? []) {
    if (typeof v.value === 'string') v.value = redact(v.value);
    for (const f of v.stacktrace?.frames ?? []) delete f.vars;
  }
  return event;
}

// The SDK key must be word characters only: GlitchTip shows it without dashes, and the SDK rejects a dashed key.
function acceptable(dsn: string): boolean {
  try {
    const u = new URL(dsn);
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    return (u.protocol === 'https:' || (u.protocol === 'http:' && local)) && /^\w+$/.test(u.username) && /^\d+$/.test(u.pathname.split('/').pop() ?? '');
  } catch {
    return false;
  }
}

async function fetchRuntimeConfig(): Promise<unknown> {
  const res = await fetch('/runtime-config.json', { cache: 'no-store', credentials: 'omit' });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) throw new Error('no runtime config');
  return res.json();
}

export async function initErrorTracking(
  deps: { fetchConfig?: () => Promise<unknown>; loadSdk?: () => Promise<WebSdk> } = {},
): Promise<boolean> {
  let cfg: { glitchtipDsn?: unknown; environment?: unknown; release?: unknown } | null;
  try {
    cfg = (await (deps.fetchConfig ?? fetchRuntimeConfig)()) as typeof cfg;
  } catch {
    return false;
  }
  const dsn = cfg && typeof cfg === 'object' ? cfg.glitchtipDsn : undefined;
  if (typeof dsn !== 'string' || !acceptable(dsn)) return false;
  const sdk = await (deps.loadSdk ?? (() => import('@sentry/browser') as unknown as Promise<WebSdk>))();
  sdk.init({
    dsn,
    environment: typeof cfg!.environment === 'string' && cfg!.environment ? cfg!.environment : 'production',
    release: typeof cfg!.release === 'string' && cfg!.release ? cfg!.release : undefined,
    defaultIntegrations: false,
    integrations: [sdk.globalHandlersIntegration(), sdk.dedupeIntegration(), sdk.linkedErrorsIntegration(), sdk.browserApiErrorsIntegration()],
    maxBreadcrumbs: 0,
    sendDefaultPii: false,
    beforeSend: scrubBrowserEvent,
  });
  return true;
}
