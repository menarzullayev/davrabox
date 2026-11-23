import { useId } from 'react';
import { WORDMARK } from './wordmarkPaths';

/** The compact mark: a ring (the davra), a rhomb in the middle (the box) and one amber dot (a participant). */
export function LogoMark({ size = 32, title }: { size?: number; title?: string }) {
  const cut = `dx-cut-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} focusable="false" {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}>
      {title ? <title>{title}</title> : null}
      <defs>
        <mask id={cut}>
          <rect width="64" height="64" fill="#fff" />
          <circle cx="50.38" cy="16.57" r="10" fill="#000" />
        </mask>
      </defs>
      <circle cx="32" cy="32" r="24" fill="none" stroke="var(--logo-ring, var(--accent))" strokeWidth="6" mask={`url(#${cut})`} />
      <rect x="25" y="25" width="14" height="14" rx="3.36" fill="var(--logo-ink, var(--text))" transform="rotate(45 32 32)" />
      <circle cx="50.38" cy="16.57" r="6.5" fill="var(--logo-dot, var(--gold))" />
    </svg>
  );
}

/** Wordmark "DavraBox" as outlines (no font dependency). Follows the current text colour. */
export function Wordmark({ height = 28, title }: { height?: number; title?: string }) {
  const w = (WORDMARK.width / WORDMARK.height) * height;
  return (
    <svg viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.height}`} width={w} height={height} fill="currentColor" focusable="false" {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}>
      {title ? <title>{title}</title> : null}
      <path d={WORDMARK.davra} />
      <path d={WORDMARK.box} />
    </svg>
  );
}

/** Mark + wordmark lock-up. */
export function Logo({ height = 32, title }: { height?: number; title?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: height * 0.28, color: 'var(--text)' }} role={title ? 'img' : undefined} aria-label={title}>
      <LogoMark size={height} />
      <Wordmark height={height * 0.72} />
    </span>
  );
}
