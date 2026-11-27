// A short tone when someone joins (rising) or leaves (falling): the "join/leave sound" host setting. Quiet and brief.
let ctx: AudioContext | null = null;
export function chime(up: boolean): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    ctx ??= new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const t0 = ctx.currentTime;
    o.frequency.setValueAtTime(up ? 660 : 880, t0);
    o.frequency.linearRampToValueAtTime(up ? 880 : 660, t0 + 0.18);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start(t0);
    o.stop(t0 + 0.26);
  } catch {
    /* no audio */
  }
}
