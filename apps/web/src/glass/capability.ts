// Can this browser refract? An SVG filter reference inside backdrop-filter is drawn by Chromium engines only (Chrome, Edge,
// Android WebView, Electron). Safari and Firefox parse `backdrop-filter: url(#f)` but draw nothing, and iOS browsers are all
// WebKit, so they get the CSS glass. Detection is by engine, then confirmed with CSS.supports.

interface Brand {
  brand: string;
}
export interface CapabilityWindow {
  navigator?: { userAgent?: string; userAgentData?: { brands?: Brand[] } };
  CSS?: { supports?: (prop: string, value: string) => boolean };
}

export function isChromiumEngine(win: CapabilityWindow): boolean {
  const brands = win.navigator?.userAgentData?.brands;
  if (Array.isArray(brands) && brands.some((b) => /Chromium/i.test(b.brand))) return true;
  const ua = win.navigator?.userAgent ?? '';
  // iOS Chrome/Edge (CriOS/EdgiOS) are WebKit underneath; Firefox never says "Chrome/".
  return /\bChrome\/\d+/.test(ua) && !/\b(CriOS|EdgiOS|FxiOS|Firefox)\//.test(ua);
}

export function canRefract(win: CapabilityWindow | undefined = typeof window === 'undefined' ? undefined : (window as unknown as CapabilityWindow)): boolean {
  if (!win || !isChromiumEngine(win)) return false;
  try {
    return win.CSS?.supports?.('backdrop-filter', 'url(#a) blur(1px)') === true;
  } catch {
    return false;
  }
}
