import { describe, expect, it } from 'vitest';
import { canRefract, isChromiumEngine } from './capability';
import { DEFAULT_GOVERNOR, GlassGovernor, batterySaverFrom } from './governor';
import { MAX_MAP_SIDE, bezelProfile, displacementMap, mapSize } from './map';

const px = (m: Uint8ClampedArray, w: number, x: number, y: number) => [m[(y * w + x) * 4]!, m[(y * w + x) * 4 + 1]!];

describe('displacement map', () => {
  const w = 200;
  const h = 60;
  const m = displacementMap({ width: w, height: h, radius: 30, bezel: 20 });
  it('has one RGBA pixel per CSS pixel', () => expect(m.length).toBe(w * h * 4));
  it('leaves the flat middle alone (128 = no shift)', () => expect(px(m, w, 100, 30)).toEqual([128, 128]));
  it('bends the edges inward along the normal: left edge samples to the right, top edge samples downward', () => {
    const [lr] = px(m, w, 1, 30);
    const [rr] = px(m, w, w - 2, 30);
    const [, tg] = px(m, w, 100, 0);
    const [, bg] = px(m, w, 100, h - 1);
    expect(lr).toBeGreaterThan(200);
    expect(rr).toBeLessThan(56);
    expect(tg).toBeGreaterThan(200);
    expect(bg).toBeLessThan(56);
  });
  it('is symmetric left/right', () => {
    const [a] = px(m, w, 5, 20);
    const [b] = px(m, w, w - 6, 20);
    expect(a! - 128).toBe(128 - b!);
  });
  it('blue is neutral and alpha opaque everywhere', () => {
    for (let k = 0; k < m.length; k += 4) {
      expect(m[k + 2]).toBe(128);
      expect(m[k + 3]).toBe(255);
    }
  });
  it('bezel profile: full at the edge, none from the bezel inwards, monotonic', () => {
    expect(bezelProfile(0, 20)).toBe(1);
    expect(bezelProfile(20, 20)).toBe(0);
    expect(bezelProfile(30, 20)).toBe(0);
    expect(bezelProfile(5, 20)).toBeGreaterThan(bezelProfile(10, 20));
    expect(bezelProfile(5, 0)).toBe(0);
  });
  it('map sizes are bucketed and capped (huge sheets are stretched, not generated at full size)', () => {
    expect(mapSize(101, 49)).toEqual({ width: 104, height: 56, factor: 1 });
    const big = mapSize(1920, 300);
    expect(Math.max(big.width, big.height)).toBeLessThanOrEqual(MAX_MAP_SIDE);
    expect(big.factor).toBeLessThan(1);
  });
});

describe('refraction support (engine)', () => {
  const css = { supports: () => true };
  it('Chromium engines refract', () => {
    expect(canRefract({ navigator: { userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Microsoft Edge' }] } }, CSS: css })).toBe(true);
    expect(canRefract({ navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36' }, CSS: css })).toBe(true);
  });
  it('Safari, Firefox and every iOS browser fall back to CSS glass', () => {
    expect(isChromiumEngine({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15' } })).toBe(false);
    expect(isChromiumEngine({ navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; rv:133.0) Gecko/20100101 Firefox/133.0' } })).toBe(false);
    expect(isChromiumEngine({ navigator: { userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/131.0 Mobile/15E148 Safari/604.1 Chrome/131' } })).toBe(false);
  });
  it('a Chromium that rejects the value, or no window, does not refract', () => {
    expect(canRefract({ navigator: { userAgentData: { brands: [{ brand: 'Chromium' }] } }, CSS: { supports: () => false } })).toBe(false);
    const throws = {
      supports: () => {
        throw new Error('x');
      },
    };
    expect(canRefract({ navigator: { userAgentData: { brands: [{ brand: 'Chromium' }] } }, CSS: throws })).toBe(false);
    expect(canRefract(undefined)).toBe(false);
  });
});

describe('glass governor (automatic degradation)', () => {
  const ready = () => {
    const g = new GlassGovernor();
    g.setEnv({ supported: true, reducedTransparency: false, saver: false, forced: null });
    return g;
  };
  it('refracts when supported and nothing asks otherwise', () => expect(ready().status()).toMatchObject({ mode: 'refract', reason: null }));
  it('falls back for an unsupported browser, reduced transparency and battery saver, in that order', () => {
    const g = ready();
    g.setEnv({ saver: true });
    expect(g.status()).toMatchObject({ mode: 'css', reason: 'battery-saver' });
    g.setEnv({ reducedTransparency: true });
    expect(g.status()).toMatchObject({ mode: 'css', reason: 'reduced-transparency' });
    g.setEnv({ supported: false });
    expect(g.status()).toMatchObject({ mode: 'css', reason: 'unsupported' });
  });
  it('switches back as soon as battery saver / reduced transparency end', () => {
    const g = ready();
    g.setEnv({ saver: true });
    g.setEnv({ saver: false });
    expect(g.status().mode).toBe('refract');
    g.setEnv({ reducedTransparency: true });
    g.setEnv({ reducedTransparency: false });
    expect(g.status().mode).toBe('refract');
  });
  it('a short dip does not switch; a sustained low frame rate does', () => {
    const g = ready();
    g.sample(30, 1000);
    g.sample(30, 2000);
    g.sample(58, 3000);
    expect(g.status().mode).toBe('refract');
    g.sample(30, 4000);
    g.sample(30, 5000);
    expect(g.sample(30, 6000)).toMatchObject({ mode: 'css', reason: 'low-fps', retryAt: 6000 + DEFAULT_GOVERNOR.backoffMs, fallbacks: 1 });
  });
  it('retries after the back-off, doubling it when the retry fails again, resetting it when the retry holds', () => {
    const g = ready();
    for (const t of [1, 2, 3]) g.sample(20, t * 1000);
    expect(g.tick(3000 + DEFAULT_GOVERNOR.backoffMs - 1).mode).toBe('css');
    expect(g.tick(3000 + DEFAULT_GOVERNOR.backoffMs).mode).toBe('refract');
    for (const t of [1, 2, 3]) g.sample(20, 30_000 + t * 1000);
    const s = g.status();
    expect(s.mode).toBe('css');
    expect(s.retryAt).toBe(33_000 + DEFAULT_GOVERNOR.backoffMs * 2);
    g.tick(s.retryAt!);
    for (let i = 0; i < DEFAULT_GOVERNOR.goodStreak; i++) g.sample(60, 100_000 + i * 1000);
    expect(g.status().backoffMs).toBe(DEFAULT_GOVERNOR.backoffMs);
  });
  it('the back-off never exceeds its ceiling', () => {
    const g = ready();
    let t = 0;
    for (let round = 0; round < 12; round++) {
      for (let i = 0; i < 3; i++) g.sample(10, (t += 1000));
      t = g.status().retryAt ?? t;
      g.tick(t);
    }
    expect(g.status().backoffMs).toBe(DEFAULT_GOVERNOR.maxBackoffMs);
  });
  it('CSS mode is never "recovered" by its own good frame rate (no flapping)', () => {
    const g = ready();
    for (const t of [1, 2, 3]) g.sample(20, t * 1000);
    for (let i = 0; i < 20; i++) g.sample(60, 4000 + i * 100);
    expect(g.status().mode).toBe('css');
  });
  it('a forced mode (measurement override) wins over everything but an unsupported browser', () => {
    const g = ready();
    g.setEnv({ saver: true, forced: 'refract' });
    expect(g.status()).toMatchObject({ mode: 'refract', reason: 'forced' });
    g.setEnv({ supported: false });
    expect(g.status().mode).toBe('css');
  });
  it('battery saver from the Battery API: discharging at 20 % or less', () => {
    expect(batterySaverFrom({ charging: false, level: 0.2 })).toBe(true);
    expect(batterySaverFrom({ charging: true, level: 0.05 })).toBe(false);
    expect(batterySaverFrom({ charging: false, level: 0.21 })).toBe(false);
    expect(batterySaverFrom(null)).toBe(false);
  });
});
