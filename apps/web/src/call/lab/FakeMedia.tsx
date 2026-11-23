import { useEffect, useRef } from 'react';
import { hashId } from '../../ui';

/**
 * Placeholder media for the call lab: one animated canvas turned into a MediaStream, attached to as many real
 * <video> elements as there are tiles, so the browser composites live video exactly as it would for a call.
 * Development only; nothing here ships unless the lab route is enabled at build time.
 */
const streams = new Map<string, MediaStream | null>();

function makeStream(key: string, w: number, h: number, fps: number, draw: (g: CanvasRenderingContext2D, t: number) => void): MediaStream | null {
  if (streams.has(key)) return streams.get(key) ?? null;
  let stream: MediaStream | null = null;
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (g && typeof c.captureStream === 'function') {
      const start = performance.now();
      const paint = () => draw(g, (performance.now() - start) / 1000);
      paint();
      setInterval(paint, 1000 / fps);
      stream = c.captureStream(fps);
    }
  } catch {
    stream = null;
  }
  streams.set(key, stream);
  return stream;
}

function cameraStream() {
  return makeStream('cam', 640, 360, 24, (g, t) => {
    const grad = g.createLinearGradient(0, 0, 640, 360);
    grad.addColorStop(0, `hsl(${(t * 20) % 360} 55% 38%)`);
    grad.addColorStop(1, `hsl(${(t * 20 + 90) % 360} 60% 22%)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 640, 360);
    for (let i = 0; i < 5; i++) {
      g.fillStyle = `hsla(${(i * 70 + t * 30) % 360} 70% 70% / 0.18)`;
      g.beginPath();
      g.arc(320 + Math.sin(t * 0.7 + i) * 240, 180 + Math.cos(t * 0.9 + i * 1.7) * 120, 60 + i * 14, 0, Math.PI * 2);
      g.fill();
    }
    // a "person": head and shoulders that sway a little
    g.fillStyle = 'rgba(255,255,255,0.28)';
    const sway = Math.sin(t * 1.3) * 10;
    g.beginPath();
    g.arc(320 + sway, 150, 52, 0, Math.PI * 2);
    g.fill();
    g.beginPath();
    g.ellipse(320 + sway * 0.6, 330, 120, 90, 0, Math.PI, 0);
    g.fill();
  });
}

function screenStream() {
  return makeStream('screen', 960, 540, 10, (g, t) => {
    g.fillStyle = '#f6f7fb';
    g.fillRect(0, 0, 960, 540);
    g.fillStyle = '#1b2250';
    g.fillRect(0, 0, 960, 56);
    g.fillStyle = '#3dd6c8';
    g.fillRect(24, 18, 120, 20);
    for (let i = 0; i < 9; i++) {
      g.fillStyle = i % 3 === 0 ? '#1b2250' : '#9aa1c9';
      g.fillRect(48, 96 + i * 44, 300 + ((i * 97 + Math.floor(t)) % 5) * 90, 14);
    }
    g.fillStyle = '#f4c24f';
    g.fillRect(560, 100, 340, 180);
    g.fillStyle = '#3dd6c8';
    g.fillRect(560, 300 + Math.sin(t) * 6, 340, 150);
  });
}

export function FakeVideo({ id, kind }: { id: string; kind: 'camera' | 'share' }) {
  const ref = useRef<HTMLVideoElement>(null);
  const stream = kind === 'share' ? screenStream() : cameraStream();
  useEffect(() => {
    const el = ref.current;
    if (el && stream) {
      el.srcObject = stream;
      void el.play().catch(() => undefined);
    }
  }, [stream]);
  const hue = kind === 'share' ? 0 : hashId(id) % 360;
  if (!stream) {
    return <div style={{ position: 'absolute', inset: 0, background: `linear-gradient(135deg, hsl(${hue} 55% 36%), hsl(${(hue + 80) % 360} 60% 20%))` }} />;
  }
  return <video ref={ref} className={kind === 'share' ? 'fit-contain' : undefined} autoPlay muted playsInline style={kind === 'share' ? undefined : { filter: `hue-rotate(${hue}deg)` }} />;
}
