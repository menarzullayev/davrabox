// Decides, moment to moment, whether glass refracts (SVG displacement in the backdrop filter) or falls back to the plain CSS
// glass (blur + tint). Pure state machine with an injected clock: the runtime feeds it the environment and one frame-rate
// sample per second during a call; the unit tests drive it directly.
//
// Order of precedence: unsupported browser > the OS asks for reduced transparency > battery saver > low frame rate.
// A low frame rate is never "recovered" by measuring in CSS mode (CSS is cheaper, so it would always look fine and the glass
// would flap); instead refraction is retried after a back-off that doubles each time the retry fails again.

export type GlassMode = 'refract' | 'css';
export type GlassReason = 'unsupported' | 'reduced-transparency' | 'battery-saver' | 'low-fps' | 'forced' | null;

export interface GlassEnv {
  /** The browser can use an SVG filter in backdrop-filter (Chromium engines). */
  supported: boolean;
  /** prefers-reduced-transparency, prefers-contrast: more or forced colours. */
  reducedTransparency: boolean;
  /** OS battery saver (Android shell) or a low, discharging battery. */
  saver: boolean;
  /** A test or measurement override (localStorage `davra.glass`). */
  forced: GlassMode | null;
}

export interface GovernorOptions {
  /** Below this many frames per second a sample counts as low. */
  lowFps: number;
  /** This many low samples in a row switch to CSS glass. */
  lowStreak: number;
  /** First retry of refraction after a low-fps fallback (ms); doubles on every failed retry up to maxBackoffMs. */
  backoffMs: number;
  maxBackoffMs: number;
  /** After a retry, this many good samples in a row reset the back-off. */
  goodStreak: number;
}

export const DEFAULT_GOVERNOR: GovernorOptions = { lowFps: 40, lowStreak: 3, backoffMs: 20_000, maxBackoffMs: 300_000, goodStreak: 10 };

export interface GlassStatus {
  mode: GlassMode;
  reason: GlassReason;
  /** Last frame-rate sample (null when not measuring). */
  fps: number | null;
  /** When refraction will be tried again after a low-fps fallback (epoch ms), else null. */
  retryAt: number | null;
  backoffMs: number;
  /** How many times the frame rate forced CSS glass (for the phone measurement report). */
  fallbacks: number;
}

export class GlassGovernor {
  private env: GlassEnv = { supported: false, reducedTransparency: false, saver: false, forced: null };
  private low = 0;
  private good = 0;
  private fpsDegraded = false;
  private retryAt: number | null = null;
  private backoff: number;
  private lastFps: number | null = null;
  private fallbacks = 0;

  constructor(private readonly opts: GovernorOptions = DEFAULT_GOVERNOR) {
    this.backoff = opts.backoffMs;
  }

  setEnv(env: Partial<GlassEnv>): GlassStatus {
    this.env = { ...this.env, ...env };
    return this.status();
  }

  /** One frame-rate sample (frames in the last second) while a call is on screen and glass refracts. */
  sample(fps: number, now: number): GlassStatus {
    this.lastFps = fps;
    if (this.base() !== 'refract' || this.fpsDegraded) return this.status();
    if (fps < this.opts.lowFps) {
      this.good = 0;
      this.low += 1;
      if (this.low >= this.opts.lowStreak) {
        this.fpsDegraded = true;
        this.fallbacks += 1;
        this.retryAt = now + this.backoff;
        this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs);
        this.low = 0;
      }
    } else {
      this.low = 0;
      this.good += 1;
      if (this.good >= this.opts.goodStreak) this.backoff = this.opts.backoffMs; // a retry held: start the back-off afresh
    }
    return this.status();
  }

  /** Time passes: retries refraction once the back-off is over. */
  tick(now: number): GlassStatus {
    if (this.fpsDegraded && this.retryAt !== null && now >= this.retryAt) {
      this.fpsDegraded = false;
      this.retryAt = null;
      this.good = 0;
      this.low = 0;
    }
    return this.status();
  }

  /** Measuring stopped (the call ended, the page is hidden): forget the streaks, keep the back-off. */
  pause(): void {
    this.low = 0;
    this.good = 0;
    this.lastFps = null;
  }

  private base(): GlassMode {
    if (!this.env.supported) return 'css';
    if (this.env.forced) return this.env.forced;
    if (this.env.reducedTransparency || this.env.saver) return 'css';
    return 'refract';
  }

  status(): GlassStatus {
    const e = this.env;
    let mode: GlassMode;
    let reason: GlassReason;
    if (!e.supported) [mode, reason] = ['css', 'unsupported'];
    else if (e.forced) [mode, reason] = [e.forced, 'forced'];
    else if (e.reducedTransparency) [mode, reason] = ['css', 'reduced-transparency'];
    else if (e.saver) [mode, reason] = ['css', 'battery-saver'];
    else if (this.fpsDegraded) [mode, reason] = ['css', 'low-fps'];
    else [mode, reason] = ['refract', null];
    return { mode, reason, fps: this.lastFps, retryAt: this.fpsDegraded ? this.retryAt : null, backoffMs: this.backoff, fallbacks: this.fallbacks };
  }
}

/** Battery saver from the Battery Status API (Chromium): discharging and at or below 20 %. */
export function batterySaverFrom(b: { charging: boolean; level: number } | null | undefined): boolean {
  return !!b && !b.charging && b.level <= 0.2;
}
