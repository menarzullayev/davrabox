/** Roving tabindex for the control bar (WAI-ARIA toolbar): one tab stop, arrow keys move between the buttons. */

export function nextRovingIndex(count: number, current: number, key: string): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowRight') return (current + 1) % count;
  if (key === 'ArrowLeft') return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/** The toolbar's items: elements marked data-roving that are not disabled. */
export function rovingItems(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-roving]')).filter((el) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true');
}

/** Gives tabindex 0 to the active item (or the first one) and -1 to the others; returns the active item. */
export function applyRoving(root: HTMLElement, active: HTMLElement | null): HTMLElement | null {
  const items = rovingItems(root);
  const current = active && items.includes(active) ? active : (items[0] ?? null);
  for (const el of root.querySelectorAll<HTMLElement>('[data-roving]')) el.tabIndex = el === current ? 0 : -1;
  return current;
}

/** Keydown handler body: moves focus and returns true when the key was handled. */
export function handleRovingKey(root: HTMLElement, e: { key: string; target: EventTarget | null; preventDefault(): void }): boolean {
  const items = rovingItems(root);
  const i = items.findIndex((el) => el === e.target);
  if (i < 0) return false;
  const next = nextRovingIndex(items.length, i, e.key);
  if (next === null) return false;
  e.preventDefault();
  items[next]!.focus();
  return true;
}
