import { useEffect, useRef, useState } from 'react';
import { t, type Lang } from '../i18n';
import { createAnnouncer, fmt, type Announcer } from './announcer';
import type { ChatLineView, ParticipantView } from './types';

export interface AnnounceInput {
  lang: Lang;
  participants: ParticipantView[];
  /** The tile in the centre (speaker or sharer); announced once it has held the stage for a moment. */
  featuredId: string | null;
  sharer: ParticipantView | null;
  waiting: number;
  lastLine: ChatLineView | undefined;
}

/**
 * Turns call events into short polite announcements: joins and leaves, raised hands, reactions, the new
 * speaker, screen sharing, chat messages and people waiting to be admitted. Everything goes through the
 * debouncing announcer, so a busy meeting produces a calm summary instead of a stream of interruptions.
 * Your own actions are never announced back to you.
 */
export function useCallAnnouncements(input: AnnounceInput): string {
  const [text, setText] = useState('');
  const announcer = useRef<Announcer | null>(null);
  const prev = useRef<{ people: Map<string, ParticipantView>; featuredId: string | null; sharerId: string | null; waiting: number; lastLine: number } | null>(null);
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    announcer.current = createAnnouncer(
      (msg) => {
        // Clear first so an identical sentence is read again later.
        setText('');
        requestAnimationFrame(() => setText(msg));
      },
      { settle: 700, maxParts: 3, dedupeMs: 3000, more: (n) => fmt(t(latest.current.lang, 'clAnnMore'), { n }) },
    );
    return () => announcer.current?.dispose();
  }, []);

  const { lang, participants, featuredId, sharer, waiting, lastLine } = input;
  useEffect(() => {
    const a = announcer.current;
    if (!a) return;
    const now = new Map(participants.map((p) => [p.id, p]));
    const before = prev.current;
    if (before) {
      for (const p of participants) {
        if (p.local) continue;
        const old = before.people.get(p.id);
        if (!old) a.say(`presence:${p.id}`, fmt(t(lang, 'clAnnJoined'), { name: p.name }));
        else {
          if (old.handUp !== p.handUp) a.say(`hand:${p.id}`, fmt(t(lang, p.handUp ? 'clAnnHandUp' : 'clAnnHandDown'), { name: p.name }));
          if (p.reaction && old.reaction !== p.reaction) a.say(`react:${p.id}`, fmt(t(lang, 'clAnnReaction'), { name: p.name, e: p.reaction }), 1000);
        }
      }
      for (const [id, old] of before.people) if (!now.has(id) && !old.local) a.say(`presence:${id}`, fmt(t(lang, 'clAnnLeft'), { name: old.name }));
      const sharerId = sharer?.id ?? null;
      if (sharerId !== before.sharerId) {
        if (sharer && !sharer.local) a.say('share', fmt(t(lang, 'clAnnShare'), { name: sharer.name }));
        else if (!sharer) {
          const gone = before.people.get(before.sharerId ?? '');
          if (gone && !gone.local) a.say('share', fmt(t(lang, 'clAnnShareStop'), { name: gone.name }));
        }
      } else if (!sharer && featuredId !== before.featuredId) {
        const f = featuredId ? now.get(featuredId) : undefined;
        // A longer settle time: a speaker who only coughed is replaced before anything is read out.
        if (f && !f.local) a.say('speaker', fmt(t(lang, 'clAnnSpeaker'), { name: f.name }), 1800);
        else a.cancel('speaker');
      }
      if (waiting > before.waiting) a.say('waiting', fmt(t(lang, 'clAnnWaiting'), { n: waiting }), 900);
      if (lastLine && lastLine.id !== before.lastLine && !lastLine.mine) {
        const key = lastLine.file ? 'clAnnFile' : lastLine.priv ? 'clAnnPrivate' : 'clAnnMessage';
        a.say('chat', fmt(t(lang, key), { name: lastLine.from }), 1200);
      }
    }
    prev.current = { people: now, featuredId, sharerId: sharer?.id ?? null, waiting, lastLine: lastLine?.id ?? 0 };
  }, [lang, participants, featuredId, sharer, waiting, lastLine]);

  return text;
}

/** The single polite live region of the call screen. */
export function LiveRegion({ text }: { text: string }) {
  return (
    <div className="dx-sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="call-live">
      {text}
    </div>
  );
}
