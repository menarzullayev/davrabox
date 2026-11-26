// The displacement map that makes glass bend the light behind it. One RGBA pixel per CSS pixel of the glass element: red is
// the horizontal shift, green the vertical one, 128 means "no shift". Inside the flat middle nothing moves; towards the rounded
// edge (the bezel) the backdrop is sampled from further inside, along the edge normal, the way a thick lens edge refracts. The SVG filter
// (feDisplacementMap) multiplies the map by `scale`, so the map itself only carries direction and strength.

export interface MapSpec {
  /** Element size in CSS pixels (whole numbers). */
  width: number;
  height: number;
  /** Corner radius in CSS pixels (clamped to half the short side: a capsule). */
  radius: number;
  /** Width of the bending band along the edge, in CSS pixels. */
  bezel: number;
}

/** Largest map we generate (per side): bigger elements are drawn at a lower resolution and stretched by the filter. */
export const MAX_MAP_SIDE = 640;

/** Strength of the bend across the bezel: 1 at the very edge, 0 where the flat middle starts (a smooth convex profile). */
export function bezelProfile(depth: number, bezel: number): number {
  if (bezel <= 0 || depth >= bezel) return 0;
  const t = 1 - Math.max(0, depth) / bezel;
  return t * t * (3 - 2 * t) * t; // smoothstep, sharpened towards the edge
}

/**
 * RGBA pixels of the map (width x height x 4). Pure function: unit-tested, and cheap enough to run on resize
 * (a 360 x 640 sheet is ~0.23 M pixels, a few milliseconds).
 */
export function displacementMap(spec: MapSpec): Uint8ClampedArray {
  const w = Math.max(1, Math.round(spec.width));
  const h = Math.max(1, Math.round(spec.height));
  const r = Math.max(0, Math.min(spec.radius, w / 2, h / 2));
  const bezel = Math.max(1, Math.min(spec.bezel, w / 2, h / 2));
  const out = new Uint8ClampedArray(w * h * 4);
  const hw = w / 2;
  const hh = h / 2;
  for (let j = 0; j < h; j++) {
    const py = j + 0.5 - hh;
    const qy = Math.abs(py) - (hh - r);
    for (let i = 0; i < w; i++) {
      const px = i + 0.5 - hw;
      const qx = Math.abs(px) - (hw - r);
      // Signed distance to the rounded rectangle (negative inside) and the outward normal at the nearest edge point.
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      let nx = 0;
      let ny = 0;
      let dist: number;
      if (ox > 0 && oy > 0) {
        const len = Math.hypot(ox, oy);
        dist = len - r;
        nx = (ox / len) * Math.sign(px);
        ny = (oy / len) * Math.sign(py);
      } else {
        dist = Math.max(qx, qy) - r;
        if (qx > qy) nx = Math.sign(px);
        else ny = Math.sign(py);
      }
      const m = bezelProfile(-dist, bezel);
      const k = (j * w + i) * 4;
      // Sample from further inside near the edge: the rim magnifies and bends what is behind it, like the edge of a thick
      // lens. (Sampling outwards reads past the element's backdrop and smears the border, measured in Edge.)
      out[k] = 128 - Math.round(nx * m * 127);
      out[k + 1] = 128 - Math.round(ny * m * 127);
      out[k + 2] = 128;
      out[k + 3] = 255;
    }
  }
  return out;
}

/** Map resolution for an element: at most MAX_MAP_SIDE per side, sizes bucketed so small resizes reuse a cached map. */
export function mapSize(width: number, height: number, bucket = 8): { width: number; height: number; factor: number } {
  const bw = Math.max(bucket, Math.ceil(width / bucket) * bucket);
  const bh = Math.max(bucket, Math.ceil(height / bucket) * bucket);
  const factor = Math.min(1, MAX_MAP_SIDE / Math.max(bw, bh));
  return { width: Math.max(1, Math.round(bw * factor)), height: Math.max(1, Math.round(bh * factor)), factor };
}
