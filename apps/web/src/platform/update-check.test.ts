// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deployedBuild, holdUpdates, runningBuild, watchForUpdates } from './update-check';

const page = (src: string) => `<!doctype html><script type="module" crossorigin src="${src}"></script>`;
const okFetch = (html: string) => vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(html) }) as unknown as typeof fetch;
let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
const flip = (v: DocumentVisibilityState) => {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('update check', () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    stops.splice(0).forEach((s) => s());
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    visibility = 'visible';
  });
  const setup = (servedSrc: string) => {
    document.head.innerHTML = '<script type="module" src="/assets/index-OLD1.js"></script>';
    let t = 0;
    const reload = vi.fn();
    const fetchFn = okFetch(page(servedSrc));
    stops.push(watchForUpdates({ fetchFn, reload, now: () => t, minHiddenMs: 60_000 }));
    return { reload, fetchFn, advance: (ms: number) => (t += ms) };
  };

  it('reads the running and the deployed build', async () => {
    document.head.innerHTML = '<script type="module" src="/assets/index-AbC_1-2.js"></script>';
    expect(runningBuild()).toBe('/assets/index-AbC_1-2.js');
    expect(await deployedBuild(okFetch(page('/assets/index-NEW.js')))).toBe('/assets/index-NEW.js');
    expect(await deployedBuild(vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch)).toBeNull();
  });

  it('reloads when the person comes back after a while and a new build is deployed', async () => {
    const s = setup('/assets/index-NEW2.js');
    flip('hidden');
    s.advance(61_000);
    flip('visible');
    await flush();
    expect(s.reload).toHaveBeenCalledOnce();
  });

  it('does nothing for a short switch away or when the build is the same', async () => {
    const a = setup('/assets/index-NEW2.js');
    flip('hidden');
    a.advance(5_000);
    flip('visible');
    await flush();
    expect(a.fetchFn).not.toHaveBeenCalled();
    stops.splice(0).forEach((s) => s());
    const b = setup('/assets/index-OLD1.js');
    flip('hidden');
    b.advance(120_000);
    flip('visible');
    await flush();
    expect(b.reload).not.toHaveBeenCalled();
  });

  it('never reloads during a call or with a dialog open', async () => {
    const s = setup('/assets/index-NEW2.js');
    const release = holdUpdates();
    flip('hidden');
    s.advance(120_000);
    flip('visible');
    await flush();
    expect(s.reload).not.toHaveBeenCalled();
    release();
    document.body.innerHTML = '<dialog open></dialog>';
    flip('hidden');
    s.advance(120_000);
    flip('visible');
    await flush();
    expect(s.reload).not.toHaveBeenCalled();
  });
});
