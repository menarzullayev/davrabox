import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, type Participant, type RemoteParticipant, type RemoteTrack, type TrackPublication } from 'livekit-client';
import { t, type Lang } from './i18n';
import { api, type JoinedResult, type JoinRequest } from './api';
import { REACTIONS, cleanChatText, decode, encode, type Reaction, type Signal } from './signals';

interface ChatLine {
  id: number;
  from: string;
  text: string;
  mine: boolean;
  to?: string; // set for private messages: the recipient's display name (or 'me' for received ones)
  priv: boolean;
}

function Tile({
  p,
  local,
  lang,
  handUp,
  reaction,
  onMute,
  onRemove,
}: {
  p: Participant;
  local: boolean;
  lang: Lang;
  handUp?: boolean;
  reaction?: Reaction;
  onMute?: () => void;
  onRemove?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shareRef = useRef<HTMLVideoElement>(null);
  const [, bump] = useState(0);

  useEffect(() => {
    const refresh = () => bump((n) => n + 1);
    p.on('trackSubscribed', refresh).on('trackUnsubscribed', refresh).on('trackMuted', refresh).on('trackUnmuted', refresh)
      .on('localTrackPublished', refresh).on('localTrackUnpublished', refresh).on('isSpeakingChanged', refresh);
    return () => {
      p.off('trackSubscribed', refresh).off('trackUnsubscribed', refresh).off('trackMuted', refresh).off('trackUnmuted', refresh)
        .off('localTrackPublished', refresh).off('localTrackUnpublished', refresh).off('isSpeakingChanged', refresh);
    };
  }, [p]);

  const cam = p.getTrackPublication(Track.Source.Camera);
  const scr = p.getTrackPublication(Track.Source.ScreenShare);
  const camTrack = cam?.track;
  const scrTrack = scr?.track;

  useEffect(() => {
    const el = videoRef.current;
    if (el && camTrack && !cam?.isMuted) {
      camTrack.attach(el);
      return () => void camTrack.detach(el);
    }
    return undefined;
  });
  useEffect(() => {
    const el = shareRef.current;
    if (el && scrTrack) {
      scrTrack.attach(el);
      return () => void scrTrack.detach(el);
    }
    return undefined;
  });

  // Remote audio must be attached to an element to play.
  const audioPub: TrackPublication | undefined = p.getTrackPublication(Track.Source.Microphone);
  const audioTrack = audioPub?.track as RemoteTrack | undefined;
  const audioRef = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = audioRef.current;
    if (!local && el && audioTrack) {
      audioTrack.attach(el);
      return () => void audioTrack.detach(el);
    }
    return undefined;
  });

  return (
    <>
      {scrTrack && (
        <div className="tile share">
          <video ref={shareRef} autoPlay playsInline muted={local} />
          <span className="label">{p.name || p.identity}</span>
        </div>
      )}
      <div className={`tile${p.isSpeaking ? ' speaking' : ''}`} data-identity={p.identity}>
        {camTrack && !cam?.isMuted ? <video ref={videoRef} autoPlay playsInline muted={local} /> : <div className="avatar">{(p.name || '?').slice(0, 1).toUpperCase()}</div>}
        <audio ref={audioRef} autoPlay />
        <span className="label">
          {p.name || p.identity}
          {local ? ` (${t(lang, 'you')})` : ''}
          {audioPub?.isMuted !== false ? ' 🔇' : ''}
          {handUp ? ' ✋' : ''}
        </span>
        {reaction && <span className="reaction" aria-live="polite" data-testid="reaction">{reaction}</span>}
        {(onMute || onRemove) && (
          <span className="tile-actions">
            {onMute && <button onClick={onMute}>{t(lang, 'muteAudio')}</button>}
            {onRemove && <button className="danger" onClick={onRemove}>{t(lang, 'removeFromMeeting')}</button>}
          </span>
        )}
      </div>
    </>
  );
}

export function Call({
  join,
  code,
  getToken,
  lang,
  onLeave,
}: {
  join: JoinedResult;
  code: string;
  getToken: () => Promise<string>;
  lang: Lang;
  onLeave: () => void;
}) {
  const roomRef = useRef<Room | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [locked, setLocked] = useState(false);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState(''); // '' = everyone, otherwise a participant identity
  const [unread, setUnread] = useState(0);
  const [hands, setHands] = useState<Record<string, boolean>>({});
  const [myHand, setMyHand] = useState(false);
  const [noiseOn, setNoiseOn] = useState<boolean | null>(null); // as reported by the live microphone track
  const [reactions, setReactions] = useState<Record<string, Reaction>>({});
  const lineId = useRef(0);
  const chatOpenRef = useRef(false);
  chatOpenRef.current = chatOpen;

  useEffect(() => {
    // Browser audio DSP is on by default; the toggle below restarts the microphone with the chosen setting.
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
    });
    roomRef.current = room;
    const sync = () => setParticipants([room.localParticipant, ...Array.from(room.remoteParticipants.values())]);
    // Only a disconnect of the room that is still current may leave the call. React StrictMode mounts,
    // unmounts and remounts this effect in development; the discarded room's disconnect must be ignored.
    let cancelled = false;
    const onDisconnected = () => {
      if (!cancelled) onLeave();
    };
    const onGone = (p: RemoteParticipant) => {
      sync();
      setHands((h) => {
        const { [p.identity]: _gone, ...rest } = h;
        return rest;
      });
    };
    // Data-channel signals: the sender comes from the SFU-verified participant, never from the payload.
    const onData = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (!participant) return;
      const sig: Signal | null = decode(payload);
      if (!sig) return;
      const id = participant.identity;
      if (sig.t === 'chat') {
        const line: ChatLine = { id: ++lineId.current, from: participant.name || id, text: sig.text, mine: false, priv: topic === 'chat-private' };
        setLines((l) => [...l.slice(-199), line]);
        if (!chatOpenRef.current) setUnread((n) => n + 1);
      } else if (sig.t === 'hand') {
        setHands((h) => ({ ...h, [id]: sig.up }));
      } else {
        setReactions((r) => ({ ...r, [id]: sig.e }));
        setTimeout(() => setReactions((r) => (r[id] === sig.e ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== id)) : r)), 3500);
      }
    };
    room
      .on(RoomEvent.ParticipantConnected, sync)
      .on(RoomEvent.ParticipantDisconnected, onGone)
      .on(RoomEvent.DataReceived, onData)
      .on(RoomEvent.Disconnected, onDisconnected);
    (async () => {
      try {
        await room.connect(join.url, join.token);
        if (cancelled) return;
        sync();
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
          await room.localParticipant.setCameraEnabled(true);
          const v = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack?.mediaStreamTrack.getSettings().noiseSuppression;
          setNoiseOn(typeof v === 'boolean' ? v : null);
        } catch {
          setError(t(lang, 'errMedia'));
          setMic(false);
          setCam(false);
        }
        sync();
      } catch {
        setError(t(lang, 'errGeneric'));
      }
    })();
    return () => {
      cancelled = true;
      void room.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [join.token]);

  // Host panel: poll the waiting room while the call is open.
  useEffect(() => {
    if (!join.isHost) return undefined;
    let stop = false;
    const tick = async () => {
      try {
        const list = await api.listRequests(await getToken(), code);
        if (!stop) setRequests(list);
      } catch {
        /* transient: try again on the next tick */
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [join.isHost, code, getToken]);

  const room = roomRef.current;
  const toggle = async (kind: 'mic' | 'cam') => {
    if (!room) return;
    try {
      if (kind === 'mic') {
        await room.localParticipant.setMicrophoneEnabled(!mic);
        setMic(!mic);
      } else {
        await room.localParticipant.setCameraEnabled(!cam);
        setCam(!cam);
      }
    } catch {
      setError(t(lang, 'errMedia'));
    }
  };
  const toggleShare = async () => {
    if (!room) return;
    try {
      await room.localParticipant.setScreenShareEnabled(!sharing, { audio: true });
      setSharing(!sharing);
    } catch {
      /* user cancelled the picker */
    }
  };
  const send = async (s: Signal, opts?: { to?: string; topic?: string }) => {
    if (!room) return;
    try {
      await room.localParticipant.publishData(encode(s), {
        reliable: true,
        topic: opts?.topic,
        destinationIdentities: opts?.to ? [opts.to] : undefined,
      });
    } catch {
      setError(t(lang, 'errGeneric'));
    }
  };
  const sendChat = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = cleanChatText(draft);
    if (!text || !room) return;
    const toName = target ? participants.find((p) => p.identity === target)?.name || target : undefined;
    await send({ t: 'chat', text }, target ? { to: target, topic: 'chat-private' } : { topic: 'chat' });
    setLines((l) => [...l.slice(-199), { id: ++lineId.current, from: t(lang, 'you'), text, mine: true, to: toName, priv: Boolean(target) }]);
    setDraft('');
  };
  const readNoise = () => {
    const track = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
    const v = track?.mediaStreamTrack.getSettings().noiseSuppression;
    setNoiseOn(typeof v === 'boolean' ? v : null);
  };
  const toggleNoise = async () => {
    const track = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack;
    if (!track) return;
    try {
      const next = !(track.mediaStreamTrack.getSettings().noiseSuppression ?? true);
      await track.restartTrack({ noiseSuppression: next, echoCancellation: true, autoGainControl: true });
      readNoise();
    } catch {
      setError(t(lang, 'errMedia'));
    }
  };
  const toggleHand = async () => {
    const up = !myHand;
    setMyHand(up);
    await send({ t: 'hand', up });
  };
  const react = async (e: Reaction) => {
    const id = room?.localParticipant.identity;
    if (id) {
      setReactions((r) => ({ ...r, [id]: e }));
      setTimeout(() => setReactions((r) => (r[id] === e ? Object.fromEntries(Object.entries(r).filter(([k]) => k !== id)) : r)), 3500);
    }
    await send({ t: 'react', e });
  };
  const hostCall = async (fn: (token: string) => Promise<unknown>) => {
    try {
      await fn(await getToken());
    } catch {
      setError(t(lang, 'errGeneric'));
    }
  };

  return (
    <div className="call">
      <header className="callbar">
        <strong>{join.title}</strong>
        {join.isHost && <span className="badge">{t(lang, 'hostBadge')}</span>}
        <span className="count" data-testid="count">{participants.length}</span>
      </header>
      {error && <div className="error">{error}</div>}
      {join.isHost && requests.length > 0 && (
        <section className="requests" aria-label={t(lang, 'requests')}>
          <strong>{t(lang, 'requests')}</strong>
          {requests.map((r) => (
            <div className="request" key={r.id} data-testid="join-request">
              <span>{r.display_name || r.email}</span>
              <button className="primary" onClick={() => hostCall((tk) => api.decide(tk, code, r.id, true).then(() => setRequests((x) => x.filter((y) => y.id !== r.id))))}>
                {t(lang, 'admit')}
              </button>
              <button onClick={() => hostCall((tk) => api.decide(tk, code, r.id, false).then(() => setRequests((x) => x.filter((y) => y.id !== r.id))))}>
                {t(lang, 'deny')}
              </button>
            </div>
          ))}
        </section>
      )}
      <div className={`stage${chatOpen ? ' with-chat' : ''}`}>
      <div className="grid" data-testid="grid">
        {participants.map((p, i) => (
          <Tile
            key={p.identity}
            p={p}
            local={i === 0}
            lang={lang}
            handUp={i === 0 ? myHand : hands[p.identity]}
            reaction={reactions[p.identity]}
            onMute={join.isHost && i > 0 ? () => void hostCall((tk) => api.mute(tk, code, p.identity)) : undefined}
            onRemove={join.isHost && i > 0 ? () => void hostCall((tk) => api.remove(tk, code, p.identity)) : undefined}
          />
        ))}
      </div>
      {chatOpen && (
        <aside className="chat" aria-label={t(lang, 'chat')} data-testid="chat-panel">
          <div className="chat-lines" data-testid="chat-lines">
            {lines.map((l) => (
              <div className={`chat-line${l.mine ? ' mine' : ''}`} key={l.id} data-testid="chat-line">
                <strong>{l.from}</strong>
                {l.priv && <em className="tag">{l.mine && l.to ? `${t(lang, 'privateTo')} ${l.to}` : t(lang, 'privateTag')}</em>}
                {/* Plain text only: React escapes it, nothing is parsed as HTML or turned into a link. */}
                <div className="chat-text">{l.text}</div>
              </div>
            ))}
          </div>
          <form onSubmit={sendChat} className="chat-form">
            <select aria-label={t(lang, 'toEveryone')} value={target} onChange={(e) => setTarget(e.target.value)} data-testid="chat-target">
              <option value="">{t(lang, 'toEveryone')}</option>
              {participants.slice(1).map((p) => (
                <option key={p.identity} value={p.identity}>{p.name || p.identity}</option>
              ))}
            </select>
            <input value={draft} maxLength={1000} placeholder={t(lang, 'chatPlaceholder')} onChange={(e) => setDraft(e.target.value)} data-testid="chat-input" />
            <button className="primary" type="submit">{t(lang, 'send')}</button>
          </form>
        </aside>
      )}
      </div>
      <footer className="controls">
        <button onClick={() => toggle('mic')} aria-pressed={mic}>{mic ? '🎤' : '🔇'} {t(lang, 'mic')}</button>
        <button onClick={() => toggle('cam')} aria-pressed={cam}>{cam ? '📷' : '🚫'} {t(lang, 'camera')}</button>
        <button onClick={toggleShare}>{sharing ? t(lang, 'stopShare') : t(lang, 'share')}</button>
        <button
          onClick={() => {
            setChatOpen(!chatOpen);
            setUnread(0);
          }}
          aria-pressed={chatOpen}
          data-testid="chat-toggle"
        >
          💬 {t(lang, 'chat')}{unread > 0 ? ` (${unread})` : ''}
        </button>
        <button onClick={toggleNoise} onFocus={readNoise} onMouseEnter={readNoise} aria-pressed={noiseOn ?? true} disabled={!mic} data-testid="noise" data-state={String(noiseOn)}>
          🎧 {t(lang, 'noiseSuppression')}
        </button>
        <button onClick={toggleHand} aria-pressed={myHand} data-testid="hand">✋ {myHand ? t(lang, 'lowerHand') : t(lang, 'raiseHand')}</button>
        <span className="reaction-bar" role="group" aria-label={t(lang, 'reactions')}>
          {REACTIONS.map((e) => (
            <button key={e} onClick={() => void react(e)} aria-label={e} data-testid={`react-${e}`}>{e}</button>
          ))}
        </span>
        {join.isHost && (
          <button onClick={() => void hostCall((tk) => api.lock(tk, code, !locked).then((r) => setLocked(r.locked)))} aria-pressed={locked} data-testid="lock">
            {locked ? t(lang, 'unlockMeeting') : t(lang, 'lockMeeting')}
          </button>
        )}
        <button className="danger" onClick={onLeave}>{t(lang, 'leave')}</button>
      </footer>
    </div>
  );
}
