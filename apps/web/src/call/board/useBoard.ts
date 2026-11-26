import { useCallback, useEffect, useRef, useState } from 'react';
import { RoomEvent, type Participant, type RemoteParticipant, type Room } from 'livekit-client';
import { isManagerRole, leadManager } from '../activity/protocol';
import { BOARD_TOPIC, NO_PERM, canDraw, mergeInto, ordered, parseBoard, type BoardElement, type BoardMsg, type BoardPerm } from './protocol';

const roleOf = (p: Participant | undefined): string | undefined => p?.attributes?.role;
const SEND_EVERY_MS = 60;

export interface BoardApi {
  /** Current elements in z-order (the scene a freshly opened board starts from). */
  elements(): BoardElement[];
  /** Remote changes for an open board: returns an unsubscribe function. */
  subscribe(fn: (els: BoardElement[]) => void): () => void;
  /** Local edits from the open board (only the changed elements are sent, at most every 60 ms). */
  localChange(els: readonly BoardElement[]): void;
  perm: BoardPerm;
  setPerm(p: BoardPerm): void;
  manager: boolean;
  canDraw: boolean;
  myId: string;
  /** Something was drawn while the board was closed. */
  activity: boolean;
  clearActivity(): void;
}

/**
 * The whiteboard store for one call. It runs whether or not the board is open, so opening it later shows everything drawn
 * so far; a late joiner gets a snapshot from the lead manager.
 */
export function useBoard(room: Room | null, connected: boolean, boardOpen: boolean, onPermEvent: (grant: boolean) => void): BoardApi {
  const store = useRef(new Map<string, BoardElement>());
  const listeners = useRef(new Set<(els: BoardElement[]) => void>());
  const [perm, setPermState] = useState<BoardPerm>(NO_PERM);
  const permRef = useRef(perm);
  permRef.current = perm;
  const [activity, setActivity] = useState(false);
  const openRef = useRef(boardOpen);
  openRef.current = boardOpen;
  const pending = useRef(new Map<string, BoardElement>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, setTick] = useState(0);

  const me = room?.localParticipant;
  const manager = isManagerRole(roleOf(me));
  const myId = me?.identity ?? '';

  const transmit = useCallback(
    (m: BoardMsg, to?: string[]) => {
      if (!room) return;
      void room.localParticipant.sendText(JSON.stringify(m), { topic: BOARD_TOPIC, destinationIdentities: to }).catch(() => undefined);
    },
    [room],
  );
  const amLead = useCallback(() => {
    if (!room) return false;
    const all = [room.localParticipant, ...Array.from(room.remoteParticipants.values())].map((p) => ({ id: p.identity, role: roleOf(p) }));
    return leadManager(all) === room.localParticipant.identity;
  }, [room]);

  const receiveEls = useCallback((els: BoardElement[]) => {
    const changed = mergeInto(store.current, els);
    if (!changed.length) return;
    listeners.current.forEach((fn) => fn(changed));
    if (!openRef.current) setActivity(true);
  }, []);

  useEffect(() => {
    if (!room || !connected) return undefined;
    const handler = (reader: { readAll(): Promise<string> }, info: { identity: string }) => {
      void reader
        .readAll()
        .then((text) => {
          const m = parseBoard(text);
          const p = room.remoteParticipants.get(info.identity);
          if (!m || !p) return;
          const senderManager = isManagerRole(roleOf(p));
          if (m.t === 'els') {
            if (canDraw(p.identity, senderManager, permRef.current)) receiveEls(m.els);
          } else if (senderManager) {
            setPermState(m.perm);
            if (m.t === 'snap') receiveEls(m.els);
          }
        })
        .catch(() => undefined);
    };
    try {
      room.registerTextStreamHandler(BOARD_TOPIC, handler);
    } catch {
      /* already registered */
    }
    const onJoin = (p: RemoteParticipant) => {
      setTimeout(() => {
        if (!amLead()) return;
        const els = ordered(store.current);
        const pm = permRef.current;
        if (els.length || pm.all || pm.ids.length) transmit({ t: 'snap', els, perm: pm }, [p.identity]);
      }, 900);
    };
    const onAttrs = () => setTick((n) => n + 1);
    room.on(RoomEvent.ParticipantConnected, onJoin).on(RoomEvent.ParticipantAttributesChanged, onAttrs);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoin).off(RoomEvent.ParticipantAttributesChanged, onAttrs);
      try {
        room.unregisterTextStreamHandler(BOARD_TOPIC);
      } catch {
        /* not registered */
      }
    };
  }, [room, connected, receiveEls, amLead, transmit]);

  const flush = useCallback(() => {
    timer.current = null;
    const els = Array.from(pending.current.values());
    pending.current.clear();
    if (els.length) transmit({ t: 'els', els });
  }, [transmit]);

  const localChange = useCallback(
    (els: readonly BoardElement[]) => {
      if (!canDraw(myId, manager, permRef.current)) return;
      for (const e of els) {
        const cur = store.current.get(e.id);
        if (cur && cur.version >= e.version) continue; // unchanged, or an echo of a remote update
        if (!cur && store.current.size >= 3000) continue;
        // Sync carries plain data only: the live element objects belong to the editor.
        const copy = JSON.parse(JSON.stringify(e)) as BoardElement;
        store.current.set(e.id, copy);
        pending.current.set(e.id, copy);
      }
      if (pending.current.size && !timer.current) timer.current = setTimeout(flush, SEND_EVERY_MS);
    },
    [flush, manager, myId],
  );

  const setPerm = useCallback(
    (p: BoardPerm) => {
      const before = permRef.current;
      setPermState(p);
      transmit({ t: 'perm', perm: p });
      const granted = (p.all && !before.all) || p.ids.some((id) => !before.ids.includes(id));
      onPermEvent(granted);
    },
    [transmit, onPermEvent],
  );

  return {
    elements: () => ordered(store.current),
    subscribe: (fn) => {
      listeners.current.add(fn);
      return () => listeners.current.delete(fn);
    },
    localChange,
    perm,
    setPerm,
    manager,
    canDraw: canDraw(myId, manager, perm),
    myId,
    activity,
    clearActivity: () => setActivity(false),
  };
}
