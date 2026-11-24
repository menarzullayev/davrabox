import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

export type PopoverAlign = 'start' | 'end';
interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Pure placement maths (unit tested): below the anchor when it fits, above when there is more room there,
 * aligned to the anchor's start or end edge, always clamped inside the viewport margin.
 */
export function computePlacement(
  anchor: Box,
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  align: PopoverAlign = 'start',
  gap = 6,
  margin = 8,
): { left: number; top: number; side: 'bottom' | 'top' } {
  const rawLeft = align === 'start' ? anchor.left : anchor.right - panel.width;
  const maxLeft = viewport.width - panel.width - margin;
  const left = Math.max(margin, Math.min(rawLeft, maxLeft));
  const below = viewport.height - anchor.bottom - gap - margin;
  const above = anchor.top - gap - margin;
  if (panel.height <= below || below >= above) return { left, top: anchor.bottom + gap, side: 'bottom' };
  return { left, top: Math.max(margin, anchor.top - gap - panel.height), side: 'top' };
}

// Open floating layers, innermost last: Escape closes only the innermost one (a dropdown inside the settings panel closes alone).
const layers: object[] = [];
/** Registers an open layer for Escape handling; returns whether this layer is the innermost one right now. */
export function useEscapeLayer(active: boolean): () => boolean {
  const token = useRef({}).current;
  useEffect(() => {
    if (!active) return;
    layers.push(token);
    return () => {
      const i = layers.indexOf(token);
      if (i >= 0) layers.splice(i, 1);
    };
  }, [active, token]);
  return useCallback(() => layers[layers.length - 1] === token, [token]);
}

export interface PopoverProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  align?: PopoverAlign;
  role?: string;
  /** Make the panel at least as wide as the anchor (dropdown lists). */
  matchAnchorWidth?: boolean;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  children: ReactNode;
}

/**
 * Floating panel anchored to an element. Closes on outside pointer-down, Escape (focus returns to the anchor) and
 * when the page is resized. Placement is `position: fixed`, so no overflow ancestor can clip it.
 */
export function Popover({ open, anchorRef, onClose, align = 'start', role, matchAnchorWidth, children, ...aria }: PopoverProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; minWidth?: number } | null>(null);
  const isTop = useEscapeLayer(open);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const a = anchorRef.current;
      const p = panel.current;
      if (!a || !p) return;
      const r = a.getBoundingClientRect();
      const { left, top } = computePlacement(r, { width: p.offsetWidth, height: p.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, align);
      setPos({ left, top, ...(matchAnchorWidth ? { minWidth: r.width } : {}) });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchorRef, align, matchAnchorWidth]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (panel.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTop()) {
        e.preventDefault(); // a dialog around the panel must not take the same Escape as its own
        e.stopPropagation();
        onClose();
        anchorRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchorRef, isTop]);

  if (!open) return null;
  return (
    <div ref={panel} className="dx-popover" role={role} data-pending={pos ? undefined : ''} style={pos ?? { left: 0, top: 0 }} {...aria}>
      {children}
    </div>
  );
}
