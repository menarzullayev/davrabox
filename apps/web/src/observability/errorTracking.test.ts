import { describe, expect, it, vi } from 'vitest';
import { initErrorTracking, scrubBrowserEvent, type WebSdk } from './errorTracking';

const hostile = () => ({
  message: 'failed Bearer abc.def password=hunter2',
  user: { id: 'u', email: 'a@b.c', ip_address: '{{auto}}' },
  request: {
    url: 'https://davrabox.example/app?join=12345678901#key=E2EEKEYMATERIAL',
    headers: { Referer: 'https://davrabox.example/app?join=12345678901', 'User-Agent': 'x' },
    cookies: { a: 'SECRETCOOKIE' },
    data: 'hunter2',
  },
  transaction: '/app?join=12345678901#key=E2EEKEYMATERIAL',
  extra: { x: 'hunter2' },
  breadcrumbs: [{ category: 'navigation', data: { from: '/a#key=E2EEKEYMATERIAL', to: '/b#key=E2EEKEYMATERIAL' } }],
  exception: { values: [{ type: 'TypeError', value: 'x is undefined for https://u:pw1234@h/', stacktrace: { frames: [{ filename: 'a.js', vars: { s: 'hunter2' } }] } }] },
});

function fakeSdk() {
  const init = vi.fn();
  const sdk: WebSdk = {
    init,
    globalHandlersIntegration: () => ({ name: 'g' }),
    dedupeIntegration: () => ({ name: 'd' }),
    linkedErrorsIntegration: () => ({ name: 'l' }),
    browserApiErrorsIntegration: () => ({ name: 'b' }),
  };
  return { sdk, init };
}

describe('scrubBrowserEvent', () => {
  it('drops the URL fragment (the E2EE key travels there), query, headers, cookies, bodies, user data and breadcrumbs', () => {
    const out = JSON.stringify(scrubBrowserEvent(hostile()));
    for (const s of ['E2EEKEYMATERIAL', 'join=12345678901', 'SECRETCOOKIE', 'hunter2', 'a@b.c', 'pw1234', 'abc.def', 'Referer']) {
      expect(out, `leaked ${s}`).not.toContain(s);
    }
  });
  it('keeps the exception type, frames and the bare page URL', () => {
    const e = scrubBrowserEvent(hostile());
    expect(e.exception.values[0]!.type).toBe('TypeError');
    expect(e.exception.values[0]!.stacktrace.frames[0]).toMatchObject({ filename: 'a.js' });
    expect(e.request).toEqual({ url: 'https://davrabox.example/app' });
  });
});

describe('initErrorTracking (web)', () => {
  it('does nothing without a configured DSN: the SDK is never loaded', async () => {
    const load = vi.fn();
    for (const cfg of [{}, { glitchtipDsn: '' }, null, 'junk', { glitchtipDsn: 42 }]) {
      expect(await initErrorTracking({ fetchConfig: async () => cfg, loadSdk: load })).toBe(false);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('is off when the config file is missing or not JSON (dev server, old image)', async () => {
    const load = vi.fn();
    expect(await initErrorTracking({ fetchConfig: async () => { throw new Error('not json'); }, loadSdk: load })).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('refuses a DSN that is not https (or http on localhost)', async () => {
    const load = vi.fn();
    for (const dsn of ['http://key@glitchtip.example/1', 'ftp://key@h/1', 'https://h/1', 'https://key@h/notanumber', 'javascript:alert(1)', 'https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@h/1']) {
      expect(await initErrorTracking({ fetchConfig: async () => ({ glitchtipDsn: dsn }), loadSdk: load })).toBe(false);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('initialises the SDK with only error capture and the scrubber', async () => {
    const { sdk, init } = fakeSdk();
    const dsn = 'https://pubkey@davrabox.example/_obs/2';
    expect(await initErrorTracking({ fetchConfig: async () => ({ glitchtipDsn: dsn, environment: 'prod', release: 'sha-1' }), loadSdk: async () => sdk })).toBe(true);
    const o = init.mock.calls[0]![0] as Record<string, unknown>;
    expect(o).toMatchObject({ dsn, environment: 'prod', release: 'sha-1', defaultIntegrations: false, maxBreadcrumbs: 0, sendDefaultPii: false });
    expect(o.beforeSend).toBe(scrubBrowserEvent);
    expect(o.tracesSampleRate).toBeUndefined();
    expect(o.replaysSessionSampleRate).toBeUndefined();
    expect((o.integrations as unknown[]).length).toBe(4);
  });

  it('accepts http only for localhost', async () => {
    const { sdk } = fakeSdk();
    expect(await initErrorTracking({ fetchConfig: async () => ({ glitchtipDsn: 'http://key@localhost:8000/1' }), loadSdk: async () => sdk })).toBe(true);
  });
});
