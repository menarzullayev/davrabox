import { useCallback, useEffect, useRef, useState } from 'react';
import { RoomEvent, type Participant, type RemoteParticipant, type Room } from 'livekit-client';
import { ACT_TOPIC, EMPTY_ACT, isManagerRole, leadManager, parseAct, reduceAct, snapshot, type ActMsg, type ActState, type Sender } from './protocol';

/** Audited events (the API records that they happened, never their content). */
export type ActivityEvent = 'poll.open' | 'poll.close' | 'qa.anon.on' | 'qa.anon.off' | 'board.draw.grant' | 'board.draw.revoke';

const roleOf = (p: Participant | undefined): string | undefined => p?.attributes?.role;

export interface ActivityApi {
  state: ActState;
  /** I am the host or a co-host (server-set role attribute). */
  manager: boolean;
  /** Present managers exist (votes need someone to count them). */
  managersPresent: boolean;
  send(m: ActMsg): void;
  /** Unseen new polls / questions while their panel is closed. */
  unseen: { polls: number; qa: number };
  markSeen(kind: 'polls' | 'qa'): void;
  /** The latest poll opened by someone else (for the notice over the stage). */
  lastPoll: { id: string; q: string } | null;
  clearLastPoll(): void;
}

/**
 * Polls and Q&A state for one call. Messages travel as LiveKit text streams (chunked, encrypted in E2EE meetings); the state
 * is reduced identically in every browser. Ballots go only to the managers; the lead manager broadcasts the counts and sends
 * a snapshot to anyone who joins late.
 */
export function useActivity(room: Room | null, connected: boolean, openPanel: string | null, onEvent: (e: ActivityEvent) => void): ActivityApi {
  const [state, setState] = useState<ActState>(EMPTY_ACT);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [unseen, setUnseen] = useState({ polls: 0, qa: 0 });
  const [lastPoll, setLastPoll] = useState<{ id: string; q: string } | null>(null);
  const panelRef = useRef(openPanel);
  panelRef.current = openPanel;
  const [, setRoleTick] = useState(0);
  const tallyTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const me = room?.localParticipant;
  const manager = isManagerRole(roleOf(me));
  const present = room ? [room.localParticipant, ...Array.from(room.remoteParticipants.values())].map((p) => ({ id: p.identity, role: roleOf(p) })) : [];
  const managersPresent = present.some((p) => isManagerRole(p.role));

  const amLead = useCallback(() => {
    if (!room) return false;
    const all = [room.localParticipant, ...Array.from(room.remoteParticipants.values())].map((p) => ({ id: p.identity, role: roleOf(p) }));
    return leadManager(all) === room.localParticipant.identity;
  }, [room]);

  const transmit = useCallback(
    (m: ActMsg, to?: string[]) => {
      if (!room) return;
      void room.localParticipant.sendText(JSON.stringify(m), { topic: ACT_TOPIC, destinationIdentities: to }).catch(() => undefined);
    },
    [room],
  );

  /** The lead manager broadcasts a poll's counts, at most twice a second per poll. */
  const scheduleTally = useCallback(
    (id: string) => {
      if (tallyTimers.current.has(id)) return;
      tallyTimers.current.set(
        id,
        setTimeout(() => {
          tallyTimers.current.delete(id);
          const p = stateRef.current.polls.find((x) => x.id === id);
          if (p && amLead()) transmit({ t: 'poll.tally', id, counts: p.counts, voters: p.voters });
        }, 500),
      );
    },
    [amLead, transmit],
  );

  const apply = useCallback(
    (m: ActMsg, from: Sender, local: boolean) => {
      const before = stateRef.current;
      const after = reduceAct(before, m, from, Date.now());
      if (after === before) return;
      stateRef.current = after;
      setState(after);
      if (!local && m.t === 'poll.open') {
        setLastPoll({ id: m.poll.id, q: m.poll.q });
        if (panelRef.current !== 'polls') setUnseen((u) => ({ ...u, polls: u.polls + 1 }));
      }
      if (!local && m.t === 'qa.ask' && panelRef.current !== 'qa') setUnseen((u) => ({ ...u, qa: u.qa + 1 }));
      if (m.t === 'poll.vote') scheduleTally(m.id);
    },
    [scheduleTally],
  );

  useEffect(() => {
    if (!room || !connected) return undefined;
    const handler = (reader: { readAll(): Promise<string> }, info: { identity: string }) => {
      void reader
        .readAll()
        .then((text) => {
          const m = parseAct(text);
          if (!m) return;
          const p = room.remoteParticipants.get(info.identity);
          if (!p) return; // only people in the room
          apply(m, { id: p.identity, name: p.name || p.identity, role: roleOf(p) }, false);
        })
        .catch(() => undefined);
    };
    try {
      room.registerTextStreamHandler(ACT_TOPIC, handler);
    } catch {
      /* already registered (StrictMode remount of the same room) */
    }
    const onJoin = (p: RemoteParticipant) => {
      // Late joiner: the lead manager sends what is going on (open and closed polls with counts, the questions, settings).
      setTimeout(() => {
        const s = stateRef.current;
        if (amLead() && (s.polls.length || s.qa.length || s.anon)) transmit(snapshot(s), [p.identity]);
      }, 800);
    };
    const onAttrs = () => setRoleTick((n) => n + 1);
    room.on(RoomEvent.ParticipantConnected, onJoin).on(RoomEvent.ParticipantAttributesChanged, onAttrs).on(RoomEvent.ParticipantDisconnected, onAttrs);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoin).off(RoomEvent.ParticipantAttributesChanged, onAttrs).off(RoomEvent.ParticipantDisconnected, onAttrs);
      try {
        room.unregisterTextStreamHandler(ACT_TOPIC);
      } catch {
        /* not registered */
      }
      tallyTimers.current.forEach((t) => clearTimeout(t));
      tallyTimers.current.clear();
    };
  }, [room, connected, apply, amLead, transmit]);

  const send = useCallback(
    (m: ActMsg) => {
      if (!room) return;
      const lp = room.localParticipant;
      const meSender: Sender = { id: lp.identity, name: lp.name || lp.identity, role: roleOf(lp) };
      if (m.t === 'poll.vote') {
        // A ballot goes to the managers only; I remember my own choice.
        const managers = Array.from(room.remoteParticipants.values()).filter((p) => isManagerRole(roleOf(p))).map((p) => p.identity);
        if (managers.length) transmit(m, managers);
        if (isManagerRole(meSender.role)) apply(m, meSender, true);
        const after = { ...stateRef.current, polls: stateRef.current.polls.map((p) => (p.id === m.id ? { ...p, mine: m.choices } : p)) };
        stateRef.current = after;
        setState(after);
        return;
      }
      transmit(m);
      apply(m, meSender, true);
      if (m.t === 'poll.open') onEvent('poll.open');
      if (m.t === 'poll.close') onEvent('poll.close');
      if (m.t === 'qa.cfg') onEvent(m.anon ? 'qa.anon.on' : 'qa.anon.off');
    },
    [room, transmit, apply, onEvent],
  );

  const markSeen = useCallback((kind: 'polls' | 'qa') => setUnseen((u) => (u[kind] ? { ...u, [kind]: 0 } : u)), []);
  return { state, manager, managersPresent, send, unseen, markSeen, lastPoll, clearLastPoll: () => setLastPoll(null) };
}
