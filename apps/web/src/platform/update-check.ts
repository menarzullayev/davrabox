// A page that stays open (the Android app above all) keeps running the build it loaded until it reloads. When the person
// comes back to it after a while and a newer build is deployed, it reloads, unless something must not be interrupted: a
// call or the pre-join step (they hold updates) or an open dialog (a form may be half filled).

const ENTRY = /\/assets\/index-[\w-]+\.js/;
let holds = 0;

/** Keeps the page from reloading for an update until the returned function is called (a call, the pre-join step). */
export function holdUpdates(): () => void {
  holds++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    holds--;
  };
}

/** The build the page runs: the entry script's hashed file name, or null when it cannot tell (development server). */
export function runningBuild(doc: Pick<Document, 'querySelectorAll'> = document): string | null {
  for (const s of Array.from(doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))) {
    const m = ENTRY.exec(s.getAttribute('src') ?? '');
    if (m) return m[0];
  }
  return null;
}

/** The build the server now serves, read from the app page; null when it cannot be read. */
export async function deployedBuild(fetchFn: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await fetchFn('/app', { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) return null;
    return ENTRY.exec(await r.text())?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Whether a reload would interrupt something now. */
export function busy(doc: Pick<Document, 'querySelector'> = document): boolean {
  return holds > 0 || doc.querySelector('dialog[open]') !== null;
}

export interface UpdateWatchDeps {
  doc?: Document;
  fetchFn?: typeof fetch;
  reload?: () => void;
  now?: () => number;
  /** How long the page must have been hidden before a return checks for a new build. */
  minHiddenMs?: number;
}

/** Starts watching; returns a function that stops. Checks when the page becomes visible after being hidden for a while. */
export function watchForUpdates(deps: UpdateWatchDeps = {}): () => void {
  const doc = deps.doc ?? document;
  const now = deps.now ?? Date.now;
  const minHidden = deps.minHiddenMs ?? 60_000;
  const running = runningBuild(doc);
  if (!running) return () => undefined;
  let hiddenAt: number | null = doc.visibilityState === 'hidden' ? now() : null;
  const onChange = () => {
    if (doc.visibilityState === 'hidden') {
      hiddenAt = now();
      return;
    }
    const away = hiddenAt === null ? 0 : now() - hiddenAt;
    hiddenAt = null;
    if (away < minHidden || busy(doc)) return;
    void deployedBuild(deps.fetchFn).then((latest) => {
      if (latest && latest !== running && !busy(doc)) (deps.reload ?? (() => location.reload()))();
    });
  };
  doc.addEventListener('visibilitychange', onChange);
  return () => doc.removeEventListener('visibilitychange', onChange);
}
