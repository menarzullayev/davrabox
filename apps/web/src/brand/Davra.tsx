import { useMemo, type CSSProperties } from 'react';
import { davraGeometry, type DavraParams } from './ornament';

export interface DavraProps extends DavraParams {
  /** Pixel size of the (square) SVG. Default 160. */
  size?: number;
  /**
   * Slowly turns the petal bands in alternating directions and pulses the hub: CSS transform/opacity only,
   * and switched off by prefers-reduced-motion. Use for connecting/loading states, not as decoration.
   */
  animated?: boolean;
  muted?: boolean;
  /** Accessible name; without it the ornament is decorative. */
  title?: string;
  className?: string;
}

export function Davra({ rings, petals, rotation, size = 160, animated, muted, title, className }: DavraProps) {
  const g = useMemo(() => davraGeometry({ rings, petals, rotation }), [rings, petals, rotation]);
  const bands = useMemo(() => {
    const out: string[][] = Array.from({ length: g.circles.length }, () => []);
    for (const p of g.petals) out[p.band]!.push(p.d);
    return out;
  }, [g]);
  const cls = `dx-davra${animated ? ' dx-davra--animated' : ''}${muted ? ' dx-davra--muted' : ''}${className ? ` ${className}` : ''}`;
  return (
    <svg
      className={cls}
      viewBox="0 0 200 200"
      width={size}
      height={size}
      focusable="false"
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      {title ? <title>{title}</title> : null}
      {g.circles.map((c) => (
        <circle key={c.r} cx="100" cy="100" r={c.r} />
      ))}
      <circle className="dx-davra__dots" cx="100" cy="100" r={g.dots.r} strokeDasharray={g.dots.dasharray} />
      {bands.map((ds, band) => (
        // Alternate direction and speed per band: an inner band turns faster, like gears of one rosette.
        <g key={band} className="dx-davra__band" style={{ '--turn': `${28 + band * 14}s`, animationDirection: band % 2 ? 'reverse' : 'normal' } as CSSProperties}>
          {ds.map((d, i) => (
            <path key={i} className="dx-davra__petal" d={d} />
          ))}
        </g>
      ))}
      <circle className="dx-davra__hub" cx="100" cy="100" r={g.hub} />
    </svg>
  );
}
