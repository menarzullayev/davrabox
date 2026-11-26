/**
 * Virtual backgrounds: the built-in images (served from our own origin, drawn by scripts/make-backgrounds.py) and the person's
 * own images. Own images are decoded and scaled down on the device and kept ONLY in this browser (IndexedDB); they are never
 * uploaded (owner decision 2026-11-26).
 */

export const BUILT_IN_BACKGROUNDS = ['davra', 'aurora', 'mountains', 'office', 'studio', 'sunset', 'bokeh', 'green', 'girih'] as const;
export type BuiltInBackground = (typeof BUILT_IN_BACKGROUNDS)[number];

export const builtInUrl = (id: BuiltInBackground) => `/backgrounds/${id}.webp`;
export const builtInThumb = (id: BuiltInBackground) => `/backgrounds/${id}.thumb.webp`;

/** What the person picked: nothing, blur, a built-in image or one of their own (`custom:<id>`). */
export type BgChoice = 'none' | 'blur' | `img:${BuiltInBackground}` | `custom:${string}`;

export const MAX_CUSTOM = 4;
/** Accepted input size before decoding (a phone photo); the stored copy is scaled to at most 1280x720. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const OUT_W = 1280;
const OUT_H = 720;

export function isBgChoice(v: unknown): v is BgChoice {
  if (v === 'none' || v === 'blur') return true;
  if (typeof v !== 'string') return false;
  if (v.startsWith('img:')) return (BUILT_IN_BACKGROUNDS as readonly string[]).includes(v.slice(4));
  return /^custom:[a-z0-9-]{1,40}$/.test(v);
}

/** Cover-crop of a w x h source into the output box (keeps the aspect ratio, cuts the overflow evenly). */
export function coverCrop(w: number, h: number, outW = OUT_W, outH = OUT_H): { sx: number; sy: number; sw: number; sh: number; dw: number; dh: number } {
  const scale = Math.min(1, Math.max(outW / w, outH / h));
  const dw = Math.min(outW, Math.round(w * scale));
  const dh = Math.min(outH, Math.round(h * scale));
  const sw = Math.round(dw / scale);
  const sh = Math.round(dh / scale);
  return { sx: Math.round((w - sw) / 2), sy: Math.round((h - sh) / 2), sw, sh, dw, dh };
}

// ---- IndexedDB: the person's own images ---------------------------------------------------------------------------
const DB = 'davra-backgrounds';
const STORE = 'images';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('no indexedDB'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => {
          db.close();
          resolve(r.result);
        };
        t.onerror = () => {
          db.close();
          reject(t.error);
        };
      }),
  );
}

export interface CustomBackground {
  id: string;
  blob: Blob;
}

export async function listCustom(): Promise<CustomBackground[]> {
  try {
    const keys = (await tx('readonly', (s) => s.getAllKeys())) as string[];
    const blobs = (await tx('readonly', (s) => s.getAll())) as Blob[];
    return keys.map((id, i) => ({ id, blob: blobs[i]! })).filter((x) => x.blob instanceof Blob);
  } catch {
    return [];
  }
}

export async function removeCustom(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

/** Decodes the picked file, scales it down and stores it. Refuses anything that is not a decodable image. */
export async function addCustom(file: File): Promise<CustomBackground> {
  if (!file.type.startsWith('image/') || file.size > MAX_UPLOAD_BYTES) throw new Error('not an image');
  const bmp = await createImageBitmap(file);
  try {
    const c = coverCrop(bmp.width, bmp.height);
    const canvas = document.createElement('canvas');
    canvas.width = c.dw;
    canvas.height = c.dh;
    canvas.getContext('2d')!.drawImage(bmp, c.sx, c.sy, c.sw, c.sh, 0, 0, c.dw, c.dh);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.86));
    const id = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).toLowerCase().slice(0, 36);
    const existing = await listCustom();
    // Oldest first out when the shelf is full.
    for (const old of existing.slice(0, Math.max(0, existing.length - (MAX_CUSTOM - 1)))) await removeCustom(old.id);
    await tx('readwrite', (s) => s.put(blob, id));
    return { id, blob };
  } finally {
    bmp.close();
  }
}

// ---- the saved choice (per device) ------------------------------------------------------------------------------------
const KEY = 'davra.camfx';
export interface CamFx {
  bg: BgChoice;
  lowLight: boolean;
}
export const NO_FX: CamFx = { bg: 'none', lowLight: false };

export function loadFx(): CamFx {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<CamFx> | null;
    if (!v || typeof v !== 'object') return NO_FX;
    return { bg: isBgChoice(v.bg) ? v.bg : 'none', lowLight: v.lowLight === true };
  } catch {
    return NO_FX;
  }
}

export function saveFx(fx: CamFx): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(fx));
  } catch {
    /* storage unavailable: the choice lasts for this call only */
  }
}
