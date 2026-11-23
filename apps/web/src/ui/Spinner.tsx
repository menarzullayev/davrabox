import type { CSSProperties } from 'react';

export interface SpinnerProps {
  size?: number;
  /** Accessible status text. Without it the spinner is decorative (aria-hidden), e.g. inside a loading button. */
  label?: string;
  className?: string;
}

/** Ring spinner: a single border arc rotated with a transform (no layout, no paint of other nodes). */
export function Spinner({ size = 20, label, className }: SpinnerProps) {
  const style = { '--s': `${size}px` } as CSSProperties;
  return label ? (
    <span role="status" className={className}>
      <span className="dx-spinner" style={style} aria-hidden="true" />
      <span className="dx-sr-only">{label}</span>
    </span>
  ) : (
    <span className={`dx-spinner${className ? ` ${className}` : ''}`} style={style} aria-hidden="true" />
  );
}
