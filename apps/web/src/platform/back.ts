// The Android Back button as a stack of "things that can be closed": the innermost open layer (a dropdown, a panel, a dialog,
// the call screen's own leave confirmation) takes the press first. Layers register while they are open; the native shell calls
// handleBack(). Pure module state, no DOM, so it can be tested.
import { useEffect, useRef } from 'react';

const stack: Array<{ run: () => void }> = [];

/** Registers a layer; returns the function that removes it. The newest layer is asked first. */
export function pushBack(run: () => void): () => void {
  const entry = { run };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Gives the press to the innermost layer. Returns false when nothing wanted it (the caller then goes back or exits). */
export function handleBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.run();
  return true;
}

/** Test helper: forget every layer. */
export function resetBackForTests(): void {
  stack.length = 0;
}

/** While `active`, Back runs `handler` (keep it a plain close: the layer removes itself when it unmounts or `active` turns false). */
export function useBackLayer(active: boolean, handler: () => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return;
    return pushBack(() => ref.current());
  }, [active]);
}
