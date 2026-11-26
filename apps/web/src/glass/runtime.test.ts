// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { startGlassRuntime } from './runtime';

const root = document.documentElement;
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  root.removeAttribute('data-style');
  root.removeAttribute('data-glass');
  root.removeAttribute('data-glass-reason');
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('glass runtime (DOM glue)', () => {
  it('does nothing outside the liquid-glass style', async () => {
    root.setAttribute('data-style', 'dashboard');
    const rt = startGlassRuntime({ doc: document, win: window });
    await tick();
    expect(root.hasAttribute('data-glass')).toBe(false);
    expect(rt.status().active).toBe(false);
    rt.stop();
  });

  it('follows the style: on with liquid-glass (CSS glass in a browser that cannot refract), off again with another style', async () => {
    root.setAttribute('data-style', 'dashboard');
    const rt = startGlassRuntime({ doc: document, win: window });
    root.setAttribute('data-style', 'liquid-glass');
    await tick();
    expect(rt.status().active).toBe(true);
    expect(root.getAttribute('data-glass')).toBe('css'); // jsdom has no CSS.supports: treated like Safari/Firefox
    expect(root.getAttribute('data-glass-reason')).toBe('unsupported');
    root.setAttribute('data-style', 'swiss');
    await tick();
    expect(rt.status().active).toBe(false);
    expect(root.hasAttribute('data-glass')).toBe(false);
    expect(document.querySelector('svg[data-glass]')).toBeNull();
    rt.stop();
  });

  it('a forced mode never lets an unsupported browser refract', async () => {
    localStorage.setItem('davra.glass', 'refract');
    root.setAttribute('data-style', 'liquid-glass');
    const rt = startGlassRuntime({ doc: document, win: window });
    await tick();
    expect(root.getAttribute('data-glass')).toBe('css');
    rt.stop();
  });

  it('stop() removes everything it added', async () => {
    root.setAttribute('data-style', 'liquid-glass');
    const rt = startGlassRuntime({ doc: document, win: window });
    await tick();
    rt.stop();
    expect(root.hasAttribute('data-glass')).toBe(false);
    root.setAttribute('data-style', 'dashboard');
    root.setAttribute('data-style', 'liquid-glass');
    await tick();
    expect(root.hasAttribute('data-glass')).toBe(false); // no longer watching
  });
});
