// In-app navigation of the signed-in application: the left panel (desktop) and the bottom tab bar (phones) switch between
// real addresses (/app, /app/meetings, ...), so Back, reload and shared links behave. No router library: the History API
// and one event. Pure path helpers are exported for tests.
import { useEffect, useState } from 'react';

export const SECTIONS = ['home', 'meetings', 'recordings', 'whiteboards', 'settings', 'devices'] as const;
export type AppSection = (typeof SECTIONS)[number];

const PATH: Record<AppSection, string> = {
  home: '/app',
  meetings: '/app/meetings',
  recordings: '/app/recordings',
  whiteboards: '/app/whiteboards',
  settings: '/app/settings',
  devices: '/app/devices',
};

export function pathFor(section: AppSection): string {
  return PATH[section];
}

/** The section an address names; anything else under /app (and /app itself) is the home screen. */
export function sectionFromPath(pathname: string): AppSection {
  const p = pathname.replace(/\/+$/, '');
  const hit = SECTIONS.find((s) => s !== 'home' && PATH[s] === p);
  return hit ?? 'home';
}

const EVENT = 'davra:navigate';

/** Goes to an in-app address without a page load (keeps the query string out: links never carry state). */
export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  if (typeof window === 'undefined') return;
  const target = path.startsWith('/') ? path : `/${path}`;
  if (`${location.pathname}${location.hash}` === target && !opts.replace) return;
  if (opts.replace) history.replaceState({}, '', target);
  else history.pushState({}, '', target);
  window.dispatchEvent(new Event(EVENT));
  window.scrollTo?.({ top: 0 });
}

/** The current pathname, following Back/Forward and navigate(). */
export function useLocationPath(): { path: string; hash: string } {
  const read = () => ({ path: typeof location === 'undefined' ? '/app' : location.pathname, hash: typeof location === 'undefined' ? '' : location.hash });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    window.addEventListener(EVENT, on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('hashchange', on);
      window.removeEventListener(EVENT, on);
    };
  }, []);
  return loc;
}

/** A plain click on an in-app link navigates in place; modified clicks (new tab, new window) keep the browser's behaviour. */
export function onLinkClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }, path: string): void {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(path);
}
