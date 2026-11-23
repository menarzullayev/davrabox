/**
 * Debounced announcer for the polite live region. Messages with the same key replace each other (only the latest
 * counts), every message waits `settle` ms so a flurry of changes becomes one update, equal texts are not repeated
 * within `dedupeMs`, and one flush carries at most `maxParts` messages (the rest is summarised), so a screen
 * reader user hears a short, calm summary instead of every event.
 */
export interface AnnouncerOptions {
  /** Default settle time per message in ms. */
  settle?: number;
  maxParts?: number;
  dedupeMs?: number;
  /** Text appended when more than maxParts messages were due, e.g. (n) => `and ${n} more updates`. */
  more?: (n: number) => string;
}

export interface Announcer {
  say(key: string, message: string, settle?: number): void;
  /** Drops a pending message (e.g. the hand went up and down again). */
  cancel(key: string): void;
  dispose(): void;
}

export function createAnnouncer(emit: (text: string) => void, opts: AnnouncerOptions = {}): Announcer {
  const { settle: defaultSettle = 700, maxParts = 3, dedupeMs = 4000, more = (n) => `+${n}` } = opts;
  const pending = new Map<string, { text: string; due: number }>();
  const recent = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (pending.size === 0) return;
    const next = Math.min(...Array.from(pending.values(), (p) => p.due));
    timer = setTimeout(flush, Math.max(0, next - Date.now()));
  };
  const flush = () => {
    const now = Date.now();
    const due = Array.from(pending.entries())
      .filter(([, p]) => p.due <= now)
      .sort((a, b) => a[1].due - b[1].due);
    for (const [k] of due) pending.delete(k);
    for (const [text, at] of recent) if (now - at > dedupeMs) recent.delete(text);
    const fresh = due.map(([, p]) => p.text).filter((text) => !recent.has(text));
    if (fresh.length > 0) {
      const shown = fresh.slice(0, maxParts);
      const rest = fresh.length - shown.length;
      for (const text of shown) recent.set(text, now);
      emit(rest > 0 ? `${shown.join('. ')}. ${more(rest)}` : shown.join('. '));
    }
    schedule();
  };
  return {
    say(key, message, settle = defaultSettle) {
      pending.set(key, { text: message, due: Date.now() + settle });
      schedule();
    },
    cancel(key) {
      pending.delete(key);
      schedule();
    },
    dispose() {
      clearTimeout(timer);
      pending.clear();
    },
  };
}

/** Replaces `{name}` style placeholders. */
export function fmt(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}
