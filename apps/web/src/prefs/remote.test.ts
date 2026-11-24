// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { getOrgPolicy, getPrefs, setOrgPolicy, setPref, startPrefsSync } from './index';
import { subscribePrefs } from './store';

const view = (over: Partial<{ prefs: Record<string, string | null>; org: { defaultStyle: string; defaultDensity: string; allowedStyles: string[] | null } }> = {}) => ({
  prefs: { lang: null, theme: null, style: null, density: null, ...(over.prefs ?? {}) },
  org: over.org ?? { defaultStyle: 'dashboard', defaultDensity: 'comfortable', allowedStyles: null },
});

let keep: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  for (const a of ['data-theme', 'data-style', 'data-density']) document.documentElement.removeAttribute(a);
  document.head.innerHTML = '<meta name="theme-color" content="#000000">';
  keep = subscribePrefs(() => undefined); // a page is showing preferences
  setOrgPolicy({ allowedStyles: null, defaultStyle: 'dashboard', defaultDensity: 'comfortable' });
});
afterEach(() => {
  keep();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const tick = async (ms = 700) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('server preferences sync', () => {
  it('applies what the person chose on another device and the organization rules', async () => {
    vi.spyOn(api, 'getPrefs').mockResolvedValue(view({ prefs: { lang: 'ru', theme: 'light', style: 'terminal', density: 'compact' }, org: { defaultStyle: 'flat', defaultDensity: 'comfortable', allowedStyles: ['flat', 'terminal'] } }));
    const stop = await startPrefsSync(async () => 't');
    expect(getPrefs()).toMatchObject({ lang: 'ru', theme: 'light', style: 'terminal', density: 'compact' });
    expect(localStorage.getItem('style')).toBe('terminal'); // remembered locally too
    expect(getOrgPolicy().allowedStyles).toEqual(['flat', 'terminal']);
    stop();
  });

  it('a person who never chose gets the organization default for this visit only', async () => {
    vi.spyOn(api, 'getPrefs').mockResolvedValue(view({ org: { defaultStyle: 'swiss', defaultDensity: 'compact', allowedStyles: null } }));
    const stop = await startPrefsSync(async () => 't');
    expect(getPrefs()).toMatchObject({ style: 'swiss', density: 'compact' });
    expect(localStorage.getItem('style')).toBeNull();
    expect(localStorage.getItem('density')).toBeNull();
    stop();
  });

  it('a locally saved style the organization does not allow falls back to its default', async () => {
    setPref('style', 'aurora');
    vi.spyOn(api, 'getPrefs').mockResolvedValue(view({ org: { defaultStyle: 'flat', defaultDensity: 'comfortable', allowedStyles: ['flat'] } }));
    const stop = await startPrefsSync(async () => 't');
    expect(getPrefs().style).toBe('flat');
    stop();
  });

  it('sends only what changed, once, after a short pause', async () => {
    vi.spyOn(api, 'getPrefs').mockResolvedValue(view());
    const put = vi.spyOn(api, 'putPrefs').mockResolvedValue({});
    const stop = await startPrefsSync(async () => 'tok');
    setPref('theme', 'light');
    setPref('style', 'material');
    setPref('style', 'flat');
    expect(put).not.toHaveBeenCalled();
    await tick();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith('tok', { theme: 'light', style: 'flat' });
    await tick(2000);
    expect(put).toHaveBeenCalledTimes(1); // nothing new to say
    stop();
    setPref('density', 'spacious');
    await tick();
    expect(put).toHaveBeenCalledTimes(1); // stopped
  });

  it('does not echo the values it just received back to the server', async () => {
    vi.spyOn(api, 'getPrefs').mockResolvedValue(view({ prefs: { style: 'swiss' } }));
    const put = vi.spyOn(api, 'putPrefs').mockResolvedValue({});
    const stop = await startPrefsSync(async () => 't');
    await tick(2000);
    expect(put).not.toHaveBeenCalled();
    stop();
  });

  it('goes back to the default style when the server refuses the chosen one (403)', async () => {
    vi.spyOn(api, 'getPrefs').mockResolvedValue(view({ org: { defaultStyle: 'flat', defaultDensity: 'comfortable', allowedStyles: null } }));
    vi.spyOn(api, 'putPrefs').mockRejectedValue({ status: 403 });
    const stop = await startPrefsSync(async () => 't');
    setPref('style', 'neobrutalism');
    await tick();
    expect(getPrefs().style).toBe('flat');
    stop();
  });

  it('keeps working locally when the server cannot be reached', async () => {
    vi.spyOn(api, 'getPrefs').mockRejectedValue(new Error('offline'));
    const stop = await startPrefsSync(async () => 't');
    setPref('theme', 'light');
    expect(getPrefs().theme).toBe('light');
    stop();
  });

  it('ignores unknown values coming from the server', async () => {
    vi.spyOn(api, 'getPrefs').mockResolvedValue(view({ prefs: { lang: 'de', theme: 'sepia', style: 'rainbow', density: 'tiny' } }));
    const stop = await startPrefsSync(async () => 't');
    expect(getPrefs().theme).toBe('dark');
    expect(getPrefs().style).toBe('dashboard');
    expect(getPrefs().density).toBe('comfortable');
    stop();
  });
});
