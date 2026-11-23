import { cloneElement, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';

export interface TooltipProps {
  content: ReactNode;
  /** A single focusable element; it receives aria-describedby while the tooltip is open. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  /** Hover delay in ms (focus opens it immediately). */
  delay?: number;
  side?: 'top' | 'bottom';
}

/**
 * Accessible tooltip (WCAG 1.4.13): opens on hover and keyboard focus, stays open while the pointer is over the
 * bubble, closes with Escape without moving focus, and the text is also exposed through aria-describedby.
 */
export function Tooltip({ content, children, delay = 400, side = 'top' }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const show = (immediate: boolean) => {
    clearTimeout(timer.current);
    if (immediate) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      hide();
    }
  };

  return (
    <span className="dx-tip" onMouseEnter={() => show(false)} onMouseLeave={hide} onFocus={() => show(true)} onBlur={hide} onKeyDown={onKeyDown}>
      {cloneElement(children, { 'aria-describedby': open ? id : undefined })}
      {open ? (
        <span className="dx-tip__pop" data-side={side} role="tooltip" id={id}>
          <span className="dx-tip__bubble">{content}</span>
        </span>
      ) : null}
    </span>
  );
}
