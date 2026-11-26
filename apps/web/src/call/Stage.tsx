import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { t, type Lang } from '../i18n';
import { fmt } from './announcer';
import { SHARE_KEY, computeLayout, resolveMode, type FallbackReason, type LayoutMode, type Size } from './layout';
import { useReducedMotion } from './motion';
import { ParticipantTile, ShareTile } from './Tile';
import type { ManageActions, ParticipantView } from './types';

export interface StageProps {
  lang: Lang;
  /** The mode the user picked; the stage may draw another one (see resolveMode) and reports why. */
  requested: LayoutMode;
  /** Stable order: local participant first, then the others in join order. */
  participants: ParticipantView[];
  featuredId: string | null;
  /** Participant whose screen is shared, if any. */
  sharer: ParticipantView | null;
  renderMedia: (kind: 'camera' | 'share', p: ParticipantView) => ReactNode;
  manage: ManageActions | null;
  /** Pin / unpin a participant on this person's own stage. */
  onPin?: (id: string) => void;
  onResolved?: (info: { mode: LayoutMode; reason: FallbackReason; overflow: number }) => void;
}

/** Measures an element once on mount and then through a ResizeObserver (one state update per frame at most). */
function useSize<T extends HTMLElement>(): [React.RefObject<T>, Size] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const r = el.getBoundingClientRect();
    setSize({ width: Math.floor(r.width), height: Math.floor(r.height) });
    if (typeof ResizeObserver === 'undefined') return undefined;
    let raf = 0;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setSize((s) => (s.width === Math.floor(box.width) && s.height === Math.floor(box.height) ? s : { width: Math.floor(box.width), height: Math.floor(box.height) })));
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);
  return [ref as React.RefObject<T>, size];
}

export function Stage({ lang, requested, participants, featuredId, sharer, renderMedia, manage, onPin, onResolved }: StageProps) {
  const [ref, size] = useSize<HTMLDivElement>();
  const reduced = useReducedMotion();
  // Stable identity while nobody joins or leaves: the layout is recomputed for the people, not for every re-render.
  const idKey = participants.map((p) => p.id).join('\u0000');
  const ids = useMemo(() => (idKey ? idKey.split('\u0000') : []), [idKey]);
  const resolved = useMemo(() => resolveMode(requested, participants.length, size, !!sharer), [requested, participants.length, size, sharer]);
  // One layout computation per change of inputs: nothing here reads the DOM.
  const layout = useMemo(
    () => computeLayout({ mode: resolved.mode, participants: ids, featuredId, hasShare: !!sharer, size }),
    [resolved.mode, ids, featuredId, sharer, size],
  );

  // Gliding only when the stage itself kept its size: a window drag or a drawer opening must not animate tiles.
  const lastSize = useRef(size);
  const animate = lastSize.current.width === size.width && lastSize.current.height === size.height;
  useEffect(() => {
    lastSize.current = size;
  }, [size]);

  useEffect(() => {
    onResolved?.({ mode: resolved.mode, reason: resolved.reason, overflow: layout.overflow });
  }, [resolved.mode, resolved.reason, layout.overflow, onResolved]);

  const place = new Map(layout.placements.map((p) => [p.key, p]));
  const centerKey = layout.placements.find((p) => p.slot === 'center' || p.slot === 'main')?.key;
  const track = layout.track;

  return (
    <div
      ref={ref}
      className={`grid dv-stage${resolved.mode === 'speaker' ? ' speaker' : ''}`}
      data-testid="grid"
      data-layout={resolved.mode}
      data-requested={requested}
      role="group"
      aria-label={`${t(lang, 'clStage')}: ${participants.length}`}
    >
      {track ? (
        <svg className="dv-track" width={size.width} height={size.height} aria-hidden="true" focusable="false">
          <ellipse cx={track.cx} cy={track.cy} rx={track.rx} ry={track.ry} />
        </svg>
      ) : null}
      {layout.seats.map((s, i) =>
        participants.length > 2 ? <span key={`seat${i}`} className="dv-seat" aria-hidden="true" style={{ width: s.w, height: s.h, transform: `translate3d(${s.x}px, ${s.y}px, 0)` }} /> : null,
      )}
      {sharer && place.get(SHARE_KEY) ? (
        <ShareTile
          key="share"
          owner={sharer}
          rect={place.get(SHARE_KEY)!.rect}
          shape={place.get(SHARE_KEY)!.shape}
          slot={place.get(SHARE_KEY)!.slot}
          hidden={place.get(SHARE_KEY)!.hidden}
          featured={centerKey === SHARE_KEY}
          lang={lang}
          animate={animate}
          reduced={reduced}
          media={renderMedia('share', sharer)}
        />
      ) : null}
      {participants.map((p) => {
        const pl = place.get(p.id);
        if (!pl) return null; // the featured participant's seat while empty never reaches here; no size yet
        return (
          <ParticipantTile
            key={p.id}
            p={p}
            rect={pl.rect}
            shape={pl.shape}
            slot={pl.slot}
            hidden={pl.hidden}
            featured={centerKey === p.id}
            lang={lang}
            animate={animate}
            reduced={reduced}
            manage={manage}
            onPin={onPin}
            media={renderMedia('camera', p)}
          />
        );
      })}
      {layout.overflow > 0 ? (
        <span
          className={`dv-overflow${layout.overflowRect ? ' in-slot' : ''}`}
          style={layout.overflowRect ? { width: layout.overflowRect.w, height: layout.overflowRect.h, transform: `translate3d(${layout.overflowRect.x}px, ${layout.overflowRect.y}px, 0)` } : undefined}
        >
          {fmt(t(lang, 'clOverflow'), { n: layout.overflow })}
        </span>
      ) : null}
    </div>
  );
}
