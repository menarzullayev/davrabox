import { avatarPalette } from '@davrabox/design-tokens';
import type { CSSProperties } from 'react';

/** FNV-1a, 32 bit: stable across sessions and platforms, so a person keeps the same colour everywhere. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function avatarColor(id: string): { bg: string; fg: string } {
  return avatarPalette[hashId(id) % avatarPalette.length]!;
}

const LEAD = /^(?:[^\p{L}\p{N}]|\p{Lm})+/u; // punctuation and modifier letters such as U+02BB never count as an initial

/** First letters of the first two words, upper-cased; combining marks stay with their letter. "?" when empty. */
export function initials(name: string): string {
  const words = name
    .trim()
    .replace(LEAD, '')
    .split(/\s+/u)
    .map((w) => w.replace(LEAD, ''))
    .filter(Boolean);
  if (words.length === 0) return '?';
  const first = (w: string) => /^(\P{M}\p{M}*)/u.exec(w)?.[1] ?? '';
  const parts = words.length === 1 ? [first(words[0]!)] : [first(words[0]!), first(words[words.length - 1]!)];
  return parts.join('').toLocaleUpperCase();
}

export interface AvatarProps {
  name: string;
  /** Stable identity (user id) the colour is derived from; falls back to the name. */
  id?: string;
  size?: number;
  src?: string;
  /** speaking: gold ring; hand: amber glow (raised hand). */
  ring?: 'speaking' | 'hand';
  /** Decorative when the name is shown next to it. */
  decorative?: boolean;
}

export function Avatar({ name, id, size = 40, src, ring, decorative }: AvatarProps) {
  const c = avatarColor(id ?? name);
  const style = { '--s': `${size}px`, '--avatar-bg': c.bg, '--avatar-fg': c.fg } as CSSProperties;
  return (
    <span className="dx-avatar" style={style} data-ring={ring} {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': name })}>
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}
