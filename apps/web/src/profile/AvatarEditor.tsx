import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { t, type Lang } from '../i18n';
import { Alert, Button, Dialog, IconArrowUp, IconChevronDown, IconChevronLeft, IconChevronRight, IconMinus, IconPlus } from '../ui';
import { tx } from '../home/text';

/** Side of the uploaded square in pixels (the server accepts 64-1024). */
export const OUT_SIDE = 512;
const VIEW = 256;
const MAX_BYTES = 2 * 1024 * 1024;

export interface Crop {
  /** 1 = the shorter side of the image fills the square. */
  zoom: number;
  /** Centre of the square in image pixels. */
  cx: number;
  cy: number;
}

/** Keeps the square inside the image: the zoom at least 1 and the centre where the square still fits. */
export function clampCrop(c: Crop, w: number, h: number): Crop {
  const zoom = Math.min(8, Math.max(1, c.zoom));
  const side = Math.min(w, h) / zoom;
  const half = side / 2;
  return { zoom, cx: Math.min(w - half, Math.max(half, c.cx)), cy: Math.min(h - half, Math.max(half, c.cy)) };
}

/** The source rectangle of the crop in image pixels. */
export function cropRect(c: Crop, w: number, h: number): { sx: number; sy: number; side: number } {
  const k = clampCrop(c, w, h);
  const side = Math.min(w, h) / k.zoom;
  return { sx: k.cx - side / 2, sy: k.cy - side / 2, side };
}

function toBlob(canvas: HTMLCanvasElement, q: number): Promise<Blob | null> {
  return new Promise((r) => canvas.toBlob((b) => r(b), 'image/jpeg', q));
}

/** Opens the system file picker for one picture (no form control stays in the page). */
export function pickImage(): Promise<File | null> {
  return new Promise((resolve) => {
    const el = document.createElement('input');
    el.type = 'file';
    el.accept = 'image/jpeg,image/png,image/webp';
    el.onchange = () => resolve(el.files?.[0] ?? null);
    el.click();
  });
}

export interface AvatarEditorProps {
  lang: Lang;
  file: File | null;
  onClose: () => void;
  /** Receives the square JPEG (512 px, at most 2 MB); rejects with a message key on failure. */
  onSave: (image: Blob) => Promise<void>;
}

/**
 * Square crop of a picture in the browser (owner decision 2): drag or use the buttons/arrow keys to move, +/- to zoom. The
 * result is re-encoded to a 512 px JPEG, so metadata (location, camera) never leaves the device.
 */
export function AvatarEditor({ lang, file, onClose, onSave }: AvatarEditorProps) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [crop, setCrop] = useState<Crop>({ zoom: 1, cx: 0, cy: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const drag = useRef<{ x: number; y: number; c: Crop } | null>(null);

  useEffect(() => {
    setError(null);
    if (!file) return setImg(null);
    const url = URL.createObjectURL(file);
    const i = new Image();
    i.onload = () => {
      setImg(i);
      setCrop({ zoom: 1, cx: i.naturalWidth / 2, cy: i.naturalHeight / 2 });
    };
    i.onerror = () => setError(tx(lang, 'pfPhotoBad'));
    i.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file, lang]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv || !img) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const r = cropRect(crop, img.naturalWidth, img.naturalHeight);
    ctx.clearRect(0, 0, VIEW, VIEW);
    ctx.drawImage(img, r.sx, r.sy, r.side, r.side, 0, 0, VIEW, VIEW);
  }, [img, crop]);

  const move = (dx: number, dy: number) => {
    if (!img) return;
    const side = Math.min(img.naturalWidth, img.naturalHeight) / crop.zoom;
    setCrop((c) => clampCrop({ ...c, cx: c.cx + dx * side * 0.1, cy: c.cy + dy * side * 0.1 }, img.naturalWidth, img.naturalHeight));
  };
  const zoom = (f: number) => img && setCrop((c) => clampCrop({ ...c, zoom: c.zoom * f }, img.naturalWidth, img.naturalHeight));

  const onKey = (e: KeyboardEvent<HTMLCanvasElement>) => {
    const k: Record<string, () => void> = { ArrowLeft: () => move(-1, 0), ArrowRight: () => move(1, 0), ArrowUp: () => move(0, -1), ArrowDown: () => move(0, 1), '+': () => zoom(1.2), '=': () => zoom(1.2), '-': () => zoom(1 / 1.2) };
    const f = k[e.key];
    if (f) {
      e.preventDefault();
      f();
    }
  };
  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, c: crop };
  };
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    if (!d || !img) return;
    const scale = Math.min(img.naturalWidth, img.naturalHeight) / d.c.zoom / e.currentTarget.clientWidth;
    setCrop(clampCrop({ ...d.c, cx: d.c.cx - (e.clientX - d.x) * scale, cy: d.c.cy - (e.clientY - d.y) * scale }, img.naturalWidth, img.naturalHeight));
  };

  const save = async () => {
    if (!img || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = document.createElement('canvas');
      out.width = OUT_SIDE;
      out.height = OUT_SIDE;
      const ctx = out.getContext('2d')!;
      const r = cropRect(crop, img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, r.sx, r.sy, r.side, r.side, 0, 0, OUT_SIDE, OUT_SIDE);
      let blob: Blob | null = null;
      for (const q of [0.9, 0.8, 0.65, 0.5]) {
        blob = await toBlob(out, q);
        if (blob && blob.size <= MAX_BYTES) break;
      }
      if (!blob || blob.size > MAX_BYTES) throw new Error('pfPhotoTooLarge');
      await onSave(blob);
    } catch (e) {
      const key = e instanceof Error && /^pf[A-Z]/.test(e.message) ? e.message : 'pfPhotoFailed';
      setError(tx(lang, key as 'pfPhotoFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={file !== null}
      onClose={onClose}
      closeLabel={t(lang, 'uiClose')}
      title={tx(lang, 'pfPhotoCrop')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t(lang, 'cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!img} onClick={() => void save()} data-testid="pf-photo-save">
            {tx(lang, 'pfPhotoSave')}
          </Button>
        </>
      }
    >
      <div className="pf-crop">
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <canvas
          ref={canvas}
          width={VIEW}
          height={VIEW}
          className="pf-crop__canvas"
          tabIndex={0}
          role="img"
          aria-label={tx(lang, 'pfPhotoCrop')}
          data-testid="pf-crop"
          onKeyDown={onKey}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
        />
        <div className="pf-crop__tools">
          <Button variant="secondary" size="sm" icon={<IconMinus size={16} />} aria-label={tx(lang, 'pfZoomOut')} title={tx(lang, 'pfZoomOut')} onClick={() => zoom(1 / 1.2)} />
          <Button variant="secondary" size="sm" icon={<IconPlus size={16} />} aria-label={tx(lang, 'pfZoomIn')} title={tx(lang, 'pfZoomIn')} onClick={() => zoom(1.2)} data-testid="pf-zoom-in" />
          <Button variant="ghost" size="sm" icon={<IconChevronLeft size={16} />} aria-label={tx(lang, 'pfMoveLeft')} title={tx(lang, 'pfMoveLeft')} onClick={() => move(-1, 0)} />
          <Button variant="ghost" size="sm" icon={<IconArrowUp size={16} />} aria-label={tx(lang, 'pfMoveUp')} title={tx(lang, 'pfMoveUp')} onClick={() => move(0, -1)} />
          <Button variant="ghost" size="sm" icon={<IconChevronDown size={16} />} aria-label={tx(lang, 'pfMoveDown')} title={tx(lang, 'pfMoveDown')} onClick={() => move(0, 1)} />
          <Button variant="ghost" size="sm" icon={<IconChevronRight size={16} />} aria-label={tx(lang, 'pfMoveRight')} title={tx(lang, 'pfMoveRight')} onClick={() => move(1, 0)} />
        </div>
        <p className="pg-item__meta">{tx(lang, 'pfPhotoHint')}</p>
      </div>
    </Dialog>
  );
}
