/**
 * Whiteboard sync over the LiveKit data channel (text streams, topic `davra.board`; encrypted with the meeting key in E2EE
 * meetings). The board is ephemeral: it lives in the participants' browsers only (owner decision 10).
 *
 * Every browser keeps the same element store and merges updates by element version (Excalidraw's own rule: the higher
 * version wins, a tie goes to the lower versionNonce). Drawing rights (owner decision 11): managers always; others only with
 * the host's permission. Each receiver enforces it, so a participant without permission cannot change anyone's board.
 * Elements are sanitised on receipt: only drawing types, no links, no embeds, no images, bounded sizes.
 */

export const BOARD_TOPIC = 'davra.board';
export const MAX_ELEMENTS = 3000;
const MAX_MSG = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['rectangle', 'diamond', 'ellipse', 'arrow', 'line', 'freedraw', 'text']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_POINTS = 4000;
const MAX_TEXT = 4000;

/** An Excalidraw element as far as sync is concerned; the rest of its fields travel as they are, after sanitising. */
export interface BoardElement {
  id: string;
  type: string;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  index?: string | null;
  [k: string]: unknown;
}
export interface BoardPerm {
  /** Everyone may draw. */
  all: boolean;
  /** Participants (identities) the host allowed to draw. */
  ids: string[];
}
export const NO_PERM: BoardPerm = { all: false, ids: [] };

export type BoardMsg = { t: 'els'; els: BoardElement[] } | { t: 'snap'; els: BoardElement[]; perm: BoardPerm } | { t: 'perm'; perm: BoardPerm };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Returns a safe copy of one element, or null when it is not something the board accepts. */
export function sanitizeElement(v: unknown): BoardElement | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || !ID_RE.test(o.id) || typeof o.type !== 'string' || !ALLOWED_TYPES.has(o.type)) return null;
  if (!Number.isInteger(o.version) || (o.version as number) < 1 || !Number.isInteger(o.versionNonce)) return null;
  for (const k of ['x', 'y', 'width', 'height', 'angle'] as const) if (o[k] !== undefined && !finite(o[k])) return null;
  if (o.points !== undefined) {
    if (!Array.isArray(o.points) || o.points.length > MAX_POINTS) return null;
    if (!o.points.every((p) => Array.isArray(p) && p.length === 2 && finite(p[0]) && finite(p[1]))) return null;
  }
  if (o.pressures !== undefined && (!Array.isArray(o.pressures) || o.pressures.length > MAX_POINTS || !o.pressures.every(finite))) return null;
  for (const k of ['text', 'originalText'] as const) if (o[k] !== undefined && (typeof o[k] !== 'string' || (o[k] as string).length > MAX_TEXT)) return null;
  if (o.index !== undefined && o.index !== null && (typeof o.index !== 'string' || o.index.length > 64)) return null;
  const { link: _link, customData: _custom, fileId: _file, ...rest } = o;
  // Bound text and arrow bindings reference other elements by id; anything else is dropped.
  if (rest.boundElements !== undefined && rest.boundElements !== null) {
    if (!Array.isArray(rest.boundElements)) return null;
    rest.boundElements = rest.boundElements
      .filter((b) => typeof b === 'object' && b !== null && typeof (b as Record<string, unknown>).id === 'string' && ID_RE.test((b as Record<string, string>).id ?? ''))
      .slice(0, 64)
      .map((b) => ({ id: (b as Record<string, string>).id, type: (b as Record<string, string>).type === 'text' ? 'text' : 'arrow' }));
  }
  return { ...rest, link: null } as unknown as BoardElement;
}

function parsePerm(v: unknown): BoardPerm | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.all !== 'boolean' || !Array.isArray(o.ids)) return null;
  return { all: o.all, ids: o.ids.filter((x): x is string => typeof x === 'string' && x.length <= 80).slice(0, 500) };
}

export function parseBoard(text: string): BoardMsg | null {
  if (typeof text !== 'string' || !text || text.length > MAX_MSG) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const els = (x: unknown) => (Array.isArray(x) ? x.slice(0, MAX_ELEMENTS).map(sanitizeElement).filter((e): e is BoardElement => e !== null) : null);
  if (o.t === 'els') {
    const e = els(o.els);
    return e && e.length ? { t: 'els', els: e } : null;
  }
  if (o.t === 'snap') {
    const e = els(o.els);
    const perm = parsePerm(o.perm);
    return e && perm ? { t: 'snap', els: e, perm } : null;
  }
  if (o.t === 'perm') {
    const perm = parsePerm(o.perm);
    return perm ? { t: 'perm', perm } : null;
  }
  return null;
}

/** True when `incoming` should replace `current` (Excalidraw's reconciliation rule). */
export function newer(incoming: BoardElement, current: BoardElement | undefined): boolean {
  if (!current) return true;
  if (incoming.version !== current.version) return incoming.version > current.version;
  return incoming.versionNonce < current.versionNonce;
}

/** Merges elements into the store; returns the ones that changed it. */
export function mergeInto(store: Map<string, BoardElement>, incoming: BoardElement[]): BoardElement[] {
  const changed: BoardElement[] = [];
  for (const e of incoming) {
    if (!newer(e, store.get(e.id))) continue;
    if (!store.has(e.id) && store.size >= MAX_ELEMENTS) continue;
    store.set(e.id, e);
    changed.push(e);
  }
  return changed;
}

/** Elements in z-order (Excalidraw's fractional `index`), for an initial scene or a snapshot. */
export function ordered(store: Map<string, BoardElement>, withDeleted = false): BoardElement[] {
  const list = Array.from(store.values()).filter((e) => withDeleted || !e.isDeleted);
  return list.sort((a, b) => {
    const x = a.index ?? '';
    const y = b.index ?? '';
    return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : 1;
  });
}

export const canDraw = (id: string, manager: boolean, perm: BoardPerm): boolean => manager || perm.all || perm.ids.includes(id);
