// Liquid-glass runtime: the part of the style that CSS alone cannot do. Active only while <html data-style="liquid-glass">.
//  - Refraction: every floating glass surface (control bar, bars, sheets, menus, dialogs) gets its own SVG displacement
//    filter, sized to the element and its corner radius, referenced from its backdrop-filter (--lg-refract).
//  - Degradation: <html data-glass="refract|css"> follows the governor (unsupported browser, reduced transparency, battery
//    saver, low call frame rate with back-off retries). CSS glass is the same look without the bending.
// Components never call this: it watches the DOM, so every screen and every style keeps identical markup and test ids.
import { canRefract } from './capability';
import { GlassGovernor, batterySaverFrom, type GlassMode, type GlassStatus } from './governor';
import { displacementMap, mapSize } from './map';

export const GLASS_STYLE = 'liquid-glass';
/** The floating "navigation layer" that refracts. Content (lists, cards, tiles) uses plain material: cheaper and calmer. */
export const REFRACT_SELECTORS = [
  '.dv-toolbar',
  '.dv-topbar .dv-pill',
  '.dv-topbar .dv-lock',
  '.dv-topbar .dv-title',
  '.hm-header',
  '.ln-header',
  '.adm-top',
  '.dv-drawer',
  '.dv-requests',
  '.dv-notice',
  '.dx-popover',
  '.dx-dialog',
  '.dx-sheet',
  '.lg-glass',
  '.pj__title',
  '.pj__meeting',
  '.pj__toggles > *',
  '.pj__skip > *',
  '.pj__actions',
  '.hm-tabbar',
  '.si__card',
  '.adm-nav',
] as const;
const SELECTOR = REFRACT_SELECTORS.join(',');
const SVG_NS = 'http://www.w3.org/2000/svg';
const STORAGE_FORCE = 'davra.glass';

interface Entry {
  id: string;
  key: string;
  filter: SVGFilterElement;
}

export interface GlassRuntimeDeps {
  doc: Document;
  win: Window & typeof globalThis;
  now?: () => number;
}

export interface GlassRuntime {
  status(): GlassStatus & { active: boolean; surfaces: number };
  stop(): void;
}

function readForced(win: Window): GlassMode | null {
  try {
    const v = win.localStorage.getItem(STORAGE_FORCE);
    return v === 'refract' || v === 'css' ? v : null;
  } catch {
    return null;
  }
}

/** Element geometry the map needs: size in CSS px and the (first) corner radius in px. */
function geometry(el: HTMLElement): { w: number; h: number; r: number } {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
  const raw = cs?.borderTopLeftRadius ?? '0';
  const r = raw.endsWith('%') ? (parseFloat(raw) / 100) * Math.min(w, h) : parseFloat(raw) || 0;
  return { w, h, r };
}

export function startGlassRuntime({ doc, win, now = () => Date.now() }: GlassRuntimeDeps): GlassRuntime {
  const root = doc.documentElement;
  const gov = new GlassGovernor();
  const entries = new Map<HTMLElement, Entry>();
  const mapCache = new Map<string, string>();
  let svg: SVGSVGElement | null = null;
  let seq = 0;
  let active = false;
  let mo: MutationObserver | null = null;
  let ro: ResizeObserver | null = null;
  let raf = 0;
  let frames = 0;
  let windowStart = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const cleanups: Array<() => void> = [];

  // ---- environment --------------------------------------------------------------------------------------------------
  const mq = (q: string) => (typeof win.matchMedia === 'function' ? win.matchMedia(q) : null);
  const queries = ['(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)'].map(mq);
  const reduced = () => queries.some((m) => m?.matches === true);
  let batterySaver = false;
  let osSaver = false;
  const pushEnv = () => {
    gov.setEnv({ supported: canRefract(win as never), reducedTransparency: reduced(), saver: batterySaver || osSaver, forced: readForced(win) });
    render();
  };
  for (const m of queries) {
    if (!m) continue;
    const on = () => pushEnv();
    m.addEventListener?.('change', on);
    cleanups.push(() => m.removeEventListener?.('change', on));
  }
  const nav = win.navigator as Navigator & { getBattery?: () => Promise<EventTarget & { charging: boolean; level: number }> };
  if (typeof nav.getBattery === 'function') {
    void nav
      .getBattery()
      .then((b) => {
        const on = () => {
          batterySaver = batterySaverFrom(b);
          pushEnv();
        };
        on();
        b.addEventListener('levelchange', on);
        b.addEventListener('chargingchange', on);
        cleanups.push(() => {
          b.removeEventListener('levelchange', on);
          b.removeEventListener('chargingchange', on);
        });
      })
      .catch(() => undefined);
  }
  // Android shell: the OS battery saver (PowerSavePlugin.java). Older shells do not have it; the battery level above still counts.
  type PowerSave = { isOn?: () => Promise<{ on: boolean }>; addListener?: (e: string, cb: (d: { on: boolean }) => void) => Promise<{ remove: () => void }> | { remove: () => void } };
  const power = (win as unknown as { Capacitor?: { Plugins?: { PowerSave?: PowerSave } } }).Capacitor?.Plugins?.PowerSave;
  if (power?.isOn) {
    void power
      .isOn()
      .then((r) => {
        osSaver = !!r?.on;
        pushEnv();
      })
      .catch(() => undefined);
    try {
      const h = power.addListener?.('change', (d) => {
        osSaver = !!d?.on;
        pushEnv();
      });
      if (h) void Promise.resolve(h).then((x) => cleanups.push(() => x.remove()));
    } catch {
      /* an older shell: no change events */
    }
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_FORCE) pushEnv();
  };
  win.addEventListener('storage', onStorage);
  cleanups.push(() => win.removeEventListener('storage', onStorage));

  // ---- filters ------------------------------------------------------------------------------------------------------
  function ensureSvg(): SVGSVGElement {
    if (svg && svg.isConnected) return svg;
    svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('focusable', 'false');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
    svg.dataset['glass'] = 'filters';
    doc.body.appendChild(svg);
    return svg;
  }

  function mapUrl(w: number, h: number, r: number, bezel: number): string | null {
    const size = mapSize(w, h);
    const key = `${size.width}x${size.height}:${Math.round(r * size.factor)}:${Math.round(bezel * size.factor)}`;
    const hit = mapCache.get(key);
    if (hit) return hit;
    const canvas = doc.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const px = displacementMap({ width: size.width, height: size.height, radius: r * size.factor, bezel: bezel * size.factor });
    const img = ctx.createImageData(size.width, size.height);
    img.data.set(px);
    ctx.putImageData(img, 0, 0);
    const url = canvas.toDataURL('image/png');
    if (mapCache.size > 48) mapCache.delete(mapCache.keys().next().value as string);
    mapCache.set(key, url);
    return url;
  }

  function update(el: HTMLElement): void {
    const { w, h, r } = geometry(el);
    if (w < 8 || h < 8) return;
    const bezel = Math.max(8, Math.min(28, Math.min(w, h) * 0.34));
    const scale = Math.round(bezel * 1.35);
    const key = `${w}x${h}:${Math.round(r)}`;
    let e = entries.get(el);
    if (e && e.key === key) return;
    const url = mapUrl(w, h, r, bezel);
    if (!url) return;
    const host = ensureSvg();
    if (!e) {
      const id = `lgf-${++seq}`;
      const filter = doc.createElementNS(SVG_NS, 'filter') as SVGFilterElement;
      filter.setAttribute('id', id);
      filter.setAttribute('filterUnits', 'userSpaceOnUse');
      filter.setAttribute('primitiveUnits', 'userSpaceOnUse');
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      const image = doc.createElementNS(SVG_NS, 'feImage');
      image.setAttribute('result', 'map');
      image.setAttribute('preserveAspectRatio', 'none');
      const disp = doc.createElementNS(SVG_NS, 'feDisplacementMap');
      disp.setAttribute('in', 'SourceGraphic');
      disp.setAttribute('in2', 'map');
      disp.setAttribute('xChannelSelector', 'R');
      disp.setAttribute('yChannelSelector', 'G');
      filter.append(image, disp);
      host.appendChild(filter);
      e = { id, key: '', filter };
      entries.set(el, e);
    }
    const [image, disp] = [e.filter.children[0]!, e.filter.children[1]!];
    for (const n of [e.filter, image]) {
      n.setAttribute('x', '0');
      n.setAttribute('y', '0');
      n.setAttribute('width', String(w));
      n.setAttribute('height', String(h));
    }
    image.setAttribute('href', url);
    disp.setAttribute('scale', String(scale));
    e.key = key;
    el.style.setProperty('--lg-refract', `url(#${e.id})`);
  }

  function release(el: HTMLElement): void {
    const e = entries.get(el);
    if (!e) return;
    e.filter.remove();
    entries.delete(el);
    ro?.unobserve(el);
    el.style.removeProperty('--lg-refract');
  }

  function track(el: HTMLElement): void {
    if (entries.has(el)) return;
    ro?.observe(el);
    update(el);
  }

  function scan(node: ParentNode): void {
    if (node instanceof HTMLElement && node.matches(SELECTOR)) track(node);
    node.querySelectorAll?.<HTMLElement>(SELECTOR).forEach(track);
  }

  function sweep(): void {
    for (const el of [...entries.keys()]) if (!el.isConnected || !el.matches(SELECTOR)) release(el);
  }

  // ---- frame rate (only while a call is on screen and glass refracts) ----------------------------------------------
  const inCall = () => !!doc.querySelector('.dv-call');
  function measure(): void {
    const want = active && gov.status().mode === 'refract' && inCall() && doc.visibilityState !== 'hidden';
    if (want && !raf) {
      frames = 0;
      windowStart = now();
      const loop = () => {
        frames += 1;
        const t = now();
        if (t - windowStart >= 1000) {
          const fps = Math.round((frames * 1000) / (t - windowStart));
          frames = 0;
          windowStart = t;
          gov.sample(fps, t);
          render();
        }
        raf = active ? win.requestAnimationFrame(loop) : 0;
      };
      raf = win.requestAnimationFrame(loop);
    } else if (!want && raf) {
      win.cancelAnimationFrame(raf);
      raf = 0;
      gov.pause();
    }
  }

  // ---- state ----------------------------------------------------------------------------------------------------------
  function render(): void {
    if (!active) return;
    const s = gov.status();
    root.setAttribute('data-glass', s.mode);
    if (s.reason) root.setAttribute('data-glass-reason', s.reason);
    else root.removeAttribute('data-glass-reason');
    measure();
  }

  function activate(): void {
    if (active) return;
    active = true;
    ro = typeof win.ResizeObserver === 'function' ? new win.ResizeObserver((list) => list.forEach((r) => update(r.target as HTMLElement))) : null;
    mo = new win.MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'attributes') {
          if (m.target instanceof win.HTMLElement && m.target.matches(SELECTOR)) track(m.target);
        } else m.addedNodes.forEach((n) => n.nodeType === 1 && scan(n as HTMLElement));
      }
      sweep();
      measure();
    });
    mo.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    scan(doc.body);
    timer = setInterval(() => {
      gov.tick(now());
      render();
    }, 1000);
    pushEnv();
  }

  function deactivate(): void {
    if (!active) return;
    active = false;
    mo?.disconnect();
    ro?.disconnect();
    mo = ro = null;
    if (timer) clearInterval(timer);
    timer = null;
    if (raf) win.cancelAnimationFrame(raf);
    raf = 0;
    for (const el of [...entries.keys()]) release(el);
    svg?.remove();
    svg = null;
    root.removeAttribute('data-glass');
    root.removeAttribute('data-glass-reason');
  }

  const follow = () => (root.getAttribute('data-style') === GLASS_STYLE ? activate() : deactivate());
  const styleMo = new win.MutationObserver(follow);
  styleMo.observe(root, { attributes: true, attributeFilter: ['data-style'] });
  const onVis = () => measure();
  doc.addEventListener('visibilitychange', onVis);
  follow();

  return {
    status: () => ({ ...gov.status(), active, surfaces: entries.size }),
    stop: () => {
      styleMo.disconnect();
      doc.removeEventListener('visibilitychange', onVis);
      deactivate();
      cleanups.forEach((c) => c());
    },
  };
}

/** Starts the runtime once per page (browser only) and exposes a read-only status for the phone measurement scripts. */
export function watchGlass(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined' || !document.body) return;
  const rt = startGlassRuntime({ doc: document, win: window });
  Object.defineProperty(window, '__davraGlass', { value: Object.freeze({ status: () => rt.status() }), configurable: true });
}
