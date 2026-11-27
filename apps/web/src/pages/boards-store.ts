// Personal whiteboards (the "Whiteboards" section): kept in this browser's storage only, never sent to the server
// (in-meeting boards stay ephemeral, owner decision of 2026-11-26). Images are not allowed on these boards, so a scene is
// a small JSON document. Every access is guarded: storage may be full or switched off.

export interface BoardMeta {
  id: string;
  name: string;
  updatedAt: number;
}

const INDEX = 'davra.boards';
const KEY = (id: string) => `davra.board.${id}`;
const ID_RE = /^[a-z0-9]{8,32}$/;

export interface BoardStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function store(): BoardStore | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function listBoards(s: BoardStore | null = store()): BoardMeta[] {
  try {
    const raw = s?.getItem(INDEX);
    const v: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(v)) return [];
    return v
      .filter((b): b is BoardMeta => typeof b === 'object' && b !== null && ID_RE.test((b as BoardMeta).id) && typeof (b as BoardMeta).name === 'string' && typeof (b as BoardMeta).updatedAt === 'number')
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

function writeIndex(s: BoardStore, list: BoardMeta[]): void {
  s.setItem(INDEX, JSON.stringify(list));
}

function newId(): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Throws when the storage is unavailable or full (the page shows "could not save"). */
export function createBoard(name: string, now = Date.now(), s: BoardStore | null = store()): BoardMeta {
  if (!s) throw new Error('storage unavailable');
  const b: BoardMeta = { id: newId(), name: name.trim().slice(0, 80), updatedAt: now };
  s.setItem(KEY(b.id), '[]');
  writeIndex(s, [b, ...listBoards(s)]);
  return b;
}

export function renameBoard(id: string, name: string, s: BoardStore | null = store()): void {
  if (!s) throw new Error('storage unavailable');
  writeIndex(s, listBoards(s).map((b) => (b.id === id ? { ...b, name: name.trim().slice(0, 80) } : b)));
}

export function deleteBoard(id: string, s: BoardStore | null = store()): void {
  if (!s) return;
  s.removeItem(KEY(id));
  writeIndex(s, listBoards(s).filter((b) => b.id !== id));
}

export function loadBoard(id: string, s: BoardStore | null = store()): unknown[] {
  try {
    if (!ID_RE.test(id)) return [];
    const v: unknown = JSON.parse(s?.getItem(KEY(id)) ?? '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function saveBoard(id: string, elements: unknown[], now = Date.now(), s: BoardStore | null = store()): void {
  if (!s) throw new Error('storage unavailable');
  if (!ID_RE.test(id)) throw new Error('bad id');
  s.setItem(KEY(id), JSON.stringify(elements));
  writeIndex(s, listBoards(s).map((b) => (b.id === id ? { ...b, updatedAt: now } : b)));
}
