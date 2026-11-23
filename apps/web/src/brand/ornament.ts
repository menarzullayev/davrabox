// "Davra" ornament generator: concentric rings, a dotted border and bands of petals (lens shapes) around a hub.
// Pure and deterministic (same parameters give byte-identical output), no imports so Node can run it directly
// (build-brand.mjs uses it for the social preview). Used ONLY on sign-in, empty states and the connecting animation.

export interface DavraParams {
  /** Number of concentric ring bands, 1-6 (default 3). */
  rings?: number;
  /** Petals per band, 3-24 (default 12). */
  petals?: number;
  /** Rotation of the whole ornament in degrees, any finite number (default 0). Normalised to [0, 360). */
  rotation?: number;
}

export interface DavraGeometry {
  viewBox: 200;
  /** Ring circles from the outside in (radius in viewBox units). */
  circles: ReadonlyArray<{ r: number }>;
  /** Dotted border: a circle drawn with round-cap zero-length dashes. */
  dots: { r: number; dasharray: string };
  /** Petal outlines, `band` 0 is the outermost band. */
  petals: ReadonlyArray<{ band: number; d: string }>;
  /** Hub radius and the rotation actually applied. */
  hub: number;
  rotation: number;
}

export const DAVRA_LIMITS = { ringsMin: 1, ringsMax: 6, petalsMin: 3, petalsMax: 24 } as const;

const C = 100; // centre
const R = 92; // outer ring radius
const HUB = 7;

const num = (v: number): string => {
  const s = (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
};

export function resolveDavraParams(p: DavraParams = {}): Required<DavraParams> {
  const rings = p.rings ?? 3;
  const petals = p.petals ?? 12;
  const rotation = p.rotation ?? 0;
  if (!Number.isInteger(rings) || rings < DAVRA_LIMITS.ringsMin || rings > DAVRA_LIMITS.ringsMax) {
    throw new RangeError(`rings must be an integer ${DAVRA_LIMITS.ringsMin}-${DAVRA_LIMITS.ringsMax}, got ${String(rings)}`);
  }
  if (!Number.isInteger(petals) || petals < DAVRA_LIMITS.petalsMin || petals > DAVRA_LIMITS.petalsMax) {
    throw new RangeError(`petals must be an integer ${DAVRA_LIMITS.petalsMin}-${DAVRA_LIMITS.petalsMax}, got ${String(petals)}`);
  }
  if (typeof rotation !== 'number' || !Number.isFinite(rotation)) {
    throw new RangeError(`rotation must be a finite number, got ${String(rotation)}`);
  }
  return { rings, petals, rotation: ((rotation % 360) + 360) % 360 };
}

export function davraGeometry(params: DavraParams = {}): DavraGeometry {
  const { rings, petals, rotation } = resolveDavraParams(params);
  // Ring radii from R down to just outside the hub, evenly spaced.
  const inner = HUB + 14;
  const step = (R - inner) / rings;
  const radii = Array.from({ length: rings + 1 }, (_, k) => R - k * step);
  const circles = radii.slice(0, rings).map((r) => ({ r: Math.round(r * 100) / 100 }));

  const out: Array<{ band: number; d: string }> = [];
  for (let band = 0; band < rings; band++) {
    const ro = radii[band]!;
    const ri = radii[band + 1]!;
    const mid = (ro + ri) / 2;
    const arc = (2 * Math.PI * mid) / petals;
    const bulge = Math.min((ro - ri) * 0.62, arc * 0.42); // lens half width control offset
    const offset = band % 2 === 1 ? 180 / petals : 0; // alternate bands are staggered, like woven rows
    for (let j = 0; j < petals; j++) {
      const a = ((rotation + offset + (360 / petals) * j) * Math.PI) / 180;
      const ux = Math.sin(a);
      const uy = -Math.cos(a); // direction of the petal axis (0 deg = up)
      const px = -uy;
      const py = ux; // perpendicular
      const p0 = [C + ri * ux, C + ri * uy] as const;
      const p1 = [C + (ro - 1.5) * ux, C + (ro - 1.5) * uy] as const;
      const mx = C + mid * ux;
      const my = C + mid * uy;
      const c1 = [mx + px * bulge * 2, my + py * bulge * 2] as const;
      const c2 = [mx - px * bulge * 2, my - py * bulge * 2] as const;
      out.push({
        band,
        d: `M${num(p0[0])} ${num(p0[1])}Q${num(c1[0])} ${num(c1[1])} ${num(p1[0])} ${num(p1[1])}Q${num(c2[0])} ${num(c2[1])} ${num(p0[0])} ${num(p0[1])}Z`,
      });
    }
  }
  const dotR = R + 5;
  const dotCount = petals * 2;
  const gap = (2 * Math.PI * dotR) / dotCount;
  return {
    viewBox: 200,
    circles,
    dots: { r: dotR, dasharray: `0.01 ${num(gap - 0.01)}` },
    petals: out,
    hub: HUB,
    rotation,
  };
}

export interface DavraSvgOptions {
  size?: number;
  /** Any CSS colour, default currentColor. */
  color?: string;
  /** Hub accent colour. */
  hubColor?: string;
  stroke?: number;
  /** Fill opacity of the petals, 0-1. */
  fill?: number;
}

/** Standalone SVG string (for build scripts, tests and non-React callers). */
export function davraSvg(params: DavraParams = {}, o: DavraSvgOptions = {}): string {
  const g = davraGeometry(params);
  const size = o.size ?? 200;
  const color = o.color ?? 'currentColor';
  const stroke = o.stroke ?? 1.5;
  const fill = o.fill ?? 0.1;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="${size}" height="${size}" aria-hidden="true" fill="none" stroke="${color}" stroke-width="${stroke}">`,
    ...g.circles.map((c) => `<circle cx="100" cy="100" r="${num(c.r)}"/>`),
    `<circle cx="100" cy="100" r="${num(g.dots.r)}" stroke-width="${num(stroke * 1.6)}" stroke-linecap="round" stroke-dasharray="${g.dots.dasharray}"/>`,
    ...g.petals.map((p) => `<path d="${p.d}" fill="${color}" fill-opacity="${fill}" stroke-linejoin="round"/>`),
    `<circle cx="100" cy="100" r="${g.hub}" stroke="none" fill="${o.hubColor ?? color}"/>`,
    '</svg>',
  ];
  return parts.join('');
}
