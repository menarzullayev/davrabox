import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface SegmentedOption<T extends string> {
  id: T;
  label: ReactNode;
  /** Accessible name when it differs from the visible label (it must start with the visible text). */
  ariaLabel?: string;
  title?: string;
  lang?: string;
}

/**
 * One choice out of a few, shown as connected buttons. `radio` (default) is a radio group with arrow-key movement, for
 * settings; `pressed` is a group of toggle buttons, for quick pickers (language) where each button is also a plain control.
 * `variant` only changes the look: `pill` is round and compact, `box` is the squarer two-column setting.
 */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  mode = 'radio',
  variant = 'box',
  className,
}: {
  label: string;
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (v: T) => void;
  mode?: 'radio' | 'pressed';
  variant?: 'pill' | 'box';
  className?: string;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const move = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (mode !== 'radio') return;
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = options[(i + step + options.length) % options.length]!;
    onChange(next.id);
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(`[data-seg-id="${next.id}"]`)?.focus());
  };
  return (
    <div ref={root} className={`dx-seg${className ? ` ${className}` : ''}`} data-variant={variant} role={mode === 'radio' ? 'radiogroup' : 'group'} aria-label={label}>
      {options.map((o, i) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            className="dx-seg__btn"
            data-seg-id={o.id}
            lang={o.lang}
            title={o.title}
            aria-label={o.ariaLabel}
            {...(mode === 'radio' ? { role: 'radio', 'aria-checked': on, tabIndex: on ? 0 : -1 } : { 'aria-pressed': on })}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => move(e, i)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
