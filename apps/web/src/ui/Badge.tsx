import type { HTMLAttributes, ReactNode } from 'react';

export type Tone = 'neutral' | 'accent' | 'gold' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  /** Leading status dot (colour is never the only cue: keep the text). */
  dot?: boolean;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', dot, className, children, ...rest }: BadgeProps) {
  return (
    <span {...rest} className={`dx-badge${className ? ` ${className}` : ''}`} data-tone={tone}>
      {dot ? <span className="dx-badge__dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="dx-kbd">{children}</kbd>;
}
