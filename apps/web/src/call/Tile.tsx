import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { t, type Lang } from '../i18n';
import { Avatar, IconButton, IconHand, IconMicOff, IconShield, IconUser, IconVolume, IconX } from '../ui';
import { fmt } from './announcer';
import type { Rect, TileShape, TileSlot } from './layout';
import { GLIDE_EASING, glideDuration, glideKeyframes, sameRect } from './motion';
import type { ManageActions, ParticipantView } from './types';

export type TileSize = 'xs' | 'sm' | 'md' | 'lg';
/** Size class from the shorter side of the tile: xs < 64 < sm < 96 < md < 200 < lg. */
export function tileSize(w: number, h: number): TileSize {
  const m = Math.min(w, h);
  return m < 64 ? 'xs' : m < 96 ? 'sm' : m < 200 ? 'md' : 'lg';
}

interface Common {
  rect: Rect;
  shape: TileShape;
  slot: TileSlot;
  hidden: boolean;
  featured: boolean;
  lang: Lang;
  /** Glide to the new box (false while the stage itself is being resized, so dragging a window never animates). */
  animate: boolean;
  reduced: boolean;
  media: ReactNode;
}

function useGlide(rect: Rect, shape: TileShape, animate: boolean, reduced: boolean) {
  const tile = useRef<HTMLDivElement>(null);
  const media = useRef<HTMLDivElement>(null);
  const prev = useRef<{ rect: Rect; shape: TileShape } | null>(null);
  useLayoutEffect(() => {
    const before = prev.current;
    prev.current = { rect, shape };
    const el = tile.current;
    if (!before || !animate || reduced || !el || typeof el.animate !== 'function') return;
    if (sameRect(before.rect, rect) && before.shape === shape) return;
    const kf = glideKeyframes(before.rect, rect, before.shape, shape);
    const opts = { duration: glideDuration(reduced), easing: GLIDE_EASING };
    el.animate(kf.tile, opts);
    media.current?.animate?.(kf.media, opts);
    // The rect fields, not the object identity, decide whether the tile moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rect.x, rect.y, rect.w, rect.h, shape]);
  return { tile, media };
}

function boxStyle(rect: Rect): CSSProperties {
  const m = Math.min(rect.w, rect.h);
  return {
    width: rect.w,
    height: rect.h,
    transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
    ['--tw' as string]: `${rect.w}px`,
    ['--tm' as string]: `${m}px`,
  };
}

/** Plain-language state of a tile for the group's accessible name (colour is never the only cue). */
export function tileDescription(p: ParticipantView, lang: Lang): string {
  const parts = [p.name + (p.local ? ` (${t(lang, 'you')})` : '')];
  if (p.speaking) parts.push(t(lang, 'clWordSpeaking'));
  if (p.micMuted) parts.push(t(lang, 'clWordMuted'));
  if (!p.camOn) parts.push(t(lang, 'clWordCamOff'));
  if (p.handUp) parts.push(t(lang, 'clWordHand'));
  if (p.isCohost) parts.push(t(lang, 'cohostBadge'));
  return parts.join(', ');
}

export function ParticipantTile({ p, manage, ...c }: Common & { p: ParticipantView; manage: ManageActions | null }) {
  const { tile, media } = useGlide(c.rect, c.shape, c.animate, c.reduced);
  const size = tileSize(c.rect.w, c.rect.h);
  const avatarPx = Math.round(Math.min(c.rect.w, c.rect.h) * (c.shape === 'circle' ? 0.56 : 0.36));
  const showActions = manage && !p.local;
  return (
    <div
      ref={tile}
      className={`tile${p.speaking ? ' speaking' : ''}${c.featured ? ' featured' : ''}${p.handUp ? ' hand' : ''}`}
      data-identity={p.id}
      data-shape={c.shape}
      data-slot={c.slot}
      data-size={size}
      role="group"
      aria-label={tileDescription(p, c.lang)}
      hidden={c.hidden}
      style={boxStyle(c.rect)}
    >
      <div ref={media} className="tile-media">
        {p.camOn ? null : (
          <span className="tile-avatar">
            <Avatar name={p.name || '?'} id={p.id} size={avatarPx} decorative />
          </span>
        )}
        {c.media}
      </div>
      <span className="tile-ring" aria-hidden="true" />
      {p.handUp ? (
        <span className="tile-hand" aria-hidden="true">
          <IconHand size={size === 'xs' ? 12 : 16} />
        </span>
      ) : null}
      {/* The label is decoration for sighted users: the group's own name carries the same information. Its text
          (including the marker glyphs kept for the e2e contract) stays in the DOM. */}
      <span className="label" aria-hidden="true">
        {p.speaking ? <IconVolume size={14} className="mk-speaking" /> : null}
        <span className="label-name">
          {p.name || p.id}
          {p.local ? ` (${t(c.lang, 'you')})` : ''}
        </span>
        {p.micMuted ? (
          <span className="mk mk-muted">
            <IconMicOff size={14} />
            <span className="dx-sr-only">🔇</span>
          </span>
        ) : null}
        {p.handUp ? <span className="dx-sr-only">✋</span> : null}
        {p.isCohost ? (
          <span className="mk mk-cohost">
            <IconShield size={14} />
            <span className="dx-sr-only">★ {t(c.lang, 'cohostBadge')}</span>
          </span>
        ) : null}
      </span>
      {p.reaction ? (
        <span className="bloom" aria-hidden="true" key={p.reaction + p.id}>
          <span className="reaction" data-testid="reaction">{p.reaction}</span>
          <i>{p.reaction}</i>
          <i>{p.reaction}</i>
          <i>{p.reaction}</i>
        </span>
      ) : null}
      {showActions && size !== 'xs' ? (
        <span className="tile-actions">
          {manage.isHost ? (
            <IconButton
              label={p.isCohost ? t(c.lang, 'dismissCohost') : t(c.lang, 'makeCohost')}
              icon={<IconUser size={16} />}
              size="sm"
              variant="secondary"
              tooltip={false}
              data-testid="cohost-toggle"
              onClick={() => manage.onToggleCohost(p.id)}
            />
          ) : null}
          <IconButton label={t(c.lang, 'muteAudio')} icon={<IconMicOff size={16} />} size="sm" variant="secondary" tooltip={false} onClick={() => manage.onMute(p.id)} />
          <IconButton label={t(c.lang, 'removeFromMeeting')} icon={<IconX size={16} />} size="sm" variant="danger" tooltip={false} onClick={() => manage.onRemove(p.id)} />
        </span>
      ) : null}
    </div>
  );
}

/** The shared screen as its own tile. It has no data-identity: it is not a participant. */
export function ShareTile({ owner, ...c }: Common & { owner: ParticipantView }) {
  const { tile, media } = useGlide(c.rect, c.shape, c.animate, c.reduced);
  const text = fmt(t(c.lang, 'clScreenOf'), { name: owner.name });
  return (
    <div
      ref={tile}
      className={`tile share${c.featured ? ' featured' : ''}`}
      data-shape={c.shape}
      data-slot={c.slot}
      data-size={tileSize(c.rect.w, c.rect.h)}
      role="group"
      aria-label={text}
      hidden={c.hidden}
      style={boxStyle(c.rect)}
    >
      <div ref={media} className="tile-media">{c.media}</div>
      <span className="label" aria-hidden="true">
        <span className="label-name">{text}</span>
      </span>
    </div>
  );
}
