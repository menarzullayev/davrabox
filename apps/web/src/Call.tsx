import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, type LocalVideoTrack, type Participant, type RemoteParticipant, type RemoteTrack, type TrackPublication } from 'livekit-client';
import { t, type Lang } from './i18n';
import { BackgroundProcessor, supportsBackgroundProcessors } from '@livekit/track-processors';
import { ApiError, api, type JoinedResult, type JoinRequest } from './api';
import { MAX_FILE_BYTES, REACTIONS, cleanChatText, decode, encode, type Reaction, type Signal } from './signals';

interface ChatLine {
  id: number;
  from: string;
  text: string;
  mine: boolean;
  file?: { id: string; name: string; size: number };
  to?: string; // set for private messages: the recipient's display name (or 'me' for received ones)
  priv: boolean;
}

function Tile({
  p,
  local,
  lang,
  handUp,
  reaction,
  featured,
  isCohost,
  onCohost,
  onMute,
  onRemove,
}: {
  p: Participant;
  local: boolean;
  lang: Lang;
  featured?: boolean;
  isCohost?: boolean;
  onCohost?: () => void;
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
      <div className={`tile${p.isSpeaking ? ' speaking' : ''}${featured ? ' featured' : ''}`} data-identity={p.identity}>
        {camTrack && !cam?.isMuted ? <video ref={videoRef} autoPlay playsInline muted={local} /> : <div className="avatar">{(p.name || '?').slice(0, 1).toUpperCase()}</div>}
        <audio ref={audioRef} autoPlay />
        <span className="label">
          {p.name || p.identity}
          {local ? ` (${t(lang, 'you')})` : ''}
          {audioPub?.isMuted !== false ? ' 🔇' : ''}
          {handUp ? ' ✋' : ''}
          {isCohost ? ` ★ ${t(lang, 'cohostBadge')}` : ''}
        </span>
        {reaction && <span className="reaction" aria-live="polite" data-testid="reaction">{reaction}</span>}
        {(onMute || onRemove || onCohost) && (
          <span className="tile-actions">
            {onCohost && <button onClick={onCohost} data-testid="cohost-toggle">{isCohost ? t(lang, 'dismissCohost') : t(lang, 'makeCohost')}</button>}
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
  const [role, setRole] = useState<'host' | 'cohost' | 'member'>(join.isHost ? 'host' : 'member');
  const [cohostIds, setCohostIds] = useState<string[]>([]);
  const [blurOn, setBlurOn] = useState(false);
  const [layout, setLayout] = useState<'gallery' | 'speaker'>('gallery');
  const [speakerId, setSpeakerId] = useState<string | null>(null);
  const [reactions, setReactions] = useState<Record<string, Reaction>>({});
  const lineId = useRef(0);
  const manages = role !== 'member';
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
      } else if (sig.t === 'file') {
        const line: ChatLine = { id: ++lineId.current, from: participant.name || id, text: '', mine: false, priv: topic === 'chat-private', file: { id: sig.id, name: sig.name, size: sig.size } };
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
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        // Keep the last person who spoke featured instead of flipping back when everyone is silent.
        if (speakers.length > 0) setSpeakerId(speakers[0]!.identity);
      })
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
        // An aborted attempt of a discarded room (React StrictMode remount) is not an error for the user.
        if (!cancelled) setError(t(lang, 'errGeneric'));
      }
    })();
    return () => {
      cancelled = true;
      void room.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [join.token]);

  // Role follows promotions and demotions while connected; managers also poll the waiting room and co-host list.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const tk = await getToken();
        const me = await api.me(tk, code);
        if (stop) return;
        setRole(me.role);
        if (me.role !== 'member') {
          const [list, co] = await Promise.all([api.listRequests(tk, code), api.cohosts(tk, code)]);
          if (!stop) {
            setRequests(list);
            setCohostIds(co);
          }
        } else if (!stop) {
          setRequests([]);
          setCohostIds([]);
        }
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
  }, [code, getToken]);

  const room = roomRef.current;
  // Speaker view features a screen sharer first, then the last active speaker, then the first remote participant.
  const indexed = participants.map((p, i) => ({ p, i }));
  const sharer = participants.find((p) => p.getTrackPublication(Track.Source.ScreenShare)?.track);
  const featuredId =
    sharer?.identity ??
    (speakerId && participants.some((p) => p.identity === speakerId) ? speakerId : (participants[1] ?? participants[0])?.identity);
  const ordered = layout === 'speaker' && featuredId ? [...indexed.filter((x) => x.p.identity === featuredId), ...indexed.filter((x) => x.p.identity !== featuredId)] : indexed;
  const toggle = async (kind: 'mic' | 'cam') => {
    if (!room) return;
    try {
      if (kind === 'mic') {
        await room.localParticipant.setMicrophoneEnabled(!mic);
        setMic(!mic);
      } else {
        await room.localParticipant.setCameraEnabled(!cam);
        setCam(!cam);
        setBlurOn(false); // a new camera track starts without the processor
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
  // Background blur runs in the browser (MediaPipe segmentation). Model and WASM are served from our own origin.
  const toggleBlur = async () => {
    const track = room?.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack as LocalVideoTrack | undefined;
    if (!track) return;
    try {
      if (!blurOn) {
        if (!supportsBackgroundProcessors()) {
          setError(t(lang, 'errBlur'));
          return;
        }
        await track.setProcessor(
          BackgroundProcessor({
            mode: 'background-blur',
            blurRadius: 12,
            assetPaths: { tasksVisionFileSet: '/mediapipe/wasm', modelAssetPath: '/mediapipe/selfie_segmenter.tflite' },
          }),
        );
        setBlurOn(true);
      } else {
        await track.stopProcessor();
        setBlurOn(false);
      }
    } catch {
      setError(t(lang, 'errBlur'));
    }
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const fileError = (e: unknown): string => {
    const d = e instanceof ApiError ? e.detail : '';
    if (/not configured/i.test(d)) return t(lang, 'errFilesOff');
    if (/antivirus/i.test(d)) return t(lang, 'errFileVirus');
    if (/type is not allowed/i.test(d)) return t(lang, 'errFileType');
    if (/too large/i.test(d)) return t(lang, 'errFileSize');
    return t(lang, 'errGeneric');
  };
  const attach = async (file: File | undefined) => {
    if (!file || !room) return;
    if (file.size > MAX_FILE_BYTES) {
      setError(t(lang, 'errFileSize'));
      return;
    }
    try {
      const up = await api.uploadFile(await getToken(), code, file);
      await send({ t: 'file', id: up.id, name: up.name, size: up.size }, target ? { to: target, topic: 'chat-private' } : { topic: 'chat' });
      const toName = target ? participants.find((p) => p.identity === target)?.name || target : undefined;
      setLines((l) => [...l.slice(-199), { id: ++lineId.current, from: t(lang, 'you'), text: '', mine: true, to: toName, priv: Boolean(target), file: up }]);
    } catch (e) {
      setError(fileError(e));
    }
  };
  const saveFile = async (f: { id: string; name: string }) => {
    try {
      const blob = await api.downloadFile(await getToken(), code, f.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError(t(lang, 'errGeneric'));
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
        {manages && <span className="badge" data-testid="role-badge">{role === 'cohost' ? t(lang, 'cohostBadge') : t(lang, 'hostBadge')}</span>}
        <span className="count" data-testid="count">{participants.length}</span>
      </header>
      {error && <div className="error">{error}</div>}
      {manages && requests.length > 0 && (
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
      <div className={`grid${layout === 'speaker' ? ' speaker' : ''}`} data-testid="grid" data-layout={layout}>
        {ordered.map(({ p, i }) => (
          <Tile
            key={p.identity}
            p={p}
            local={i === 0}
            featured={layout === 'speaker' && p.identity === featuredId}
            lang={lang}
            handUp={i === 0 ? myHand : hands[p.identity]}
            reaction={reactions[p.identity]}
            onMute={manages && i > 0 ? () => void hostCall((tk) => api.mute(tk, code, p.identity)) : undefined}
            onRemove={manages && i > 0 ? () => void hostCall((tk) => api.remove(tk, code, p.identity)) : undefined}
            isCohost={cohostIds.includes(p.identity)}
            onCohost={role === 'host' && i > 0 ? () => void hostCall((tk) => api.setCohost(tk, code, p.identity, !cohostIds.includes(p.identity)).then(() => setCohostIds((c) => (c.includes(p.identity) ? c.filter((x) => x !== p.identity) : [...c, p.identity])))) : undefined}
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
                {l.file ? (
                  <button className="file-chip" onClick={() => void saveFile(l.file!)} data-testid="file-chip">
                    📎 {l.file.name} <span className="muted">({(l.file.size / 1024).toFixed(l.file.size < 10240 ? 1 : 0)} KB)</span>
                  </button>
                ) : (
                  <div className="chat-text">{l.text}</div>
                )}
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
            <input ref={fileInput} type="file" hidden onChange={(e) => { void attach(e.target.files?.[0]); e.target.value = ''; }} data-testid="file-input" />
            <button type="button" onClick={() => fileInput.current?.click()} aria-label={t(lang, 'attach')} data-testid="attach">📎</button>
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
        <button onClick={() => setLayout(layout === 'gallery' ? 'speaker' : 'gallery')} aria-pressed={layout === 'speaker'} data-testid="layout">
          ▦ {layout === 'gallery' ? t(lang, 'speakerView') : t(lang, 'galleryView')}
        </button>
        <button onClick={toggleBlur} aria-pressed={blurOn} disabled={!cam} data-testid="blur" data-state={String(blurOn)}>
          🌫 {t(lang, 'blurBackground')}
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
        {manages && (
          <button onClick={() => void hostCall((tk) => api.lock(tk, code, !locked).then((r) => setLocked(r.locked)))} aria-pressed={locked} data-testid="lock">
            {locked ? t(lang, 'unlockMeeting') : t(lang, 'lockMeeting')}
          </button>
        )}
        <button className="danger" onClick={onLeave}>{t(lang, 'leave')}</button>
      </footer>
    </div>
  );
}
