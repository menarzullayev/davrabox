import { cloneElement, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';

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
  const pop = useRef<HTMLSpanElement | null>(null);
  const [shift, setShift] = useState(0);

  useEffect(() => () => clearTimeout(timer.current), []);
  // Keep the bubble inside the screen: a button at the edge of a phone would otherwise push it off.
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const el = pop.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    setShift(r.left < margin ? margin - r.left : r.right > window.innerWidth - margin ? window.innerWidth - margin - r.right : 0);
  }, [open, content]);

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
        <span ref={pop} className="dx-tip__pop" data-side={side} role="tooltip" id={id} style={shift ? { transform: `translateX(calc(-50% + ${shift}px))` } : undefined}>
          <span className="dx-tip__bubble">{content}</span>
        </span>
      ) : null}
    </span>
  );
}
