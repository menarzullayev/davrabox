import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, type Participant, type RemoteTrack, type TrackPublication } from 'livekit-client';
import { t, type Lang } from './i18n';
import type { JoinResult } from './api';

function Tile({ p, local, lang }: { p: Participant; local: boolean; lang: Lang }) {
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
      <div className={`tile${p.isSpeaking ? ' speaking' : ''}`}>
        {camTrack && !cam?.isMuted ? <video ref={videoRef} autoPlay playsInline muted={local} /> : <div className="avatar">{(p.name || '?').slice(0, 1).toUpperCase()}</div>}
        <audio ref={audioRef} autoPlay />
        <span className="label">
          {p.name || p.identity}
          {local ? ` (${t(lang, 'you')})` : ''}
          {audioPub?.isMuted !== false ? ' 🔇' : ''}
        </span>
      </div>
    </>
  );
}

export function Call({ join, lang, onLeave }: { join: JoinResult; lang: Lang; onLeave: () => void }) {
  const roomRef = useRef<Room | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    const sync = () => setParticipants([room.localParticipant, ...Array.from(room.remoteParticipants.values())]);
    // Only a disconnect of the room that is still current may leave the call. React StrictMode mounts,
    // unmounts and remounts this effect in development; the discarded room's disconnect must be ignored.
    let cancelled = false;
    const onDisconnected = () => {
      if (!cancelled) onLeave();
    };
    room.on(RoomEvent.ParticipantConnected, sync).on(RoomEvent.ParticipantDisconnected, sync).on(RoomEvent.Disconnected, onDisconnected);
    (async () => {
      try {
        await room.connect(join.url, join.token);
        if (cancelled) return;
        sync();
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
          await room.localParticipant.setCameraEnabled(true);
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

  return (
    <div className="call">
      <header className="callbar">
        <strong>{join.title}</strong>
        {join.isHost && <span className="badge">{t(lang, 'hostBadge')}</span>}
        <span className="count">{participants.length}</span>
      </header>
      {error && <div className="error">{error}</div>}
      <div className="grid" data-testid="grid">
        {participants.map((p, i) => (
          <Tile key={p.identity} p={p} local={i === 0} lang={lang} />
        ))}
      </div>
      <footer className="controls">
        <button onClick={() => toggle('mic')} aria-pressed={mic}>{mic ? '🎤' : '🔇'} {t(lang, 'mic')}</button>
        <button onClick={() => toggle('cam')} aria-pressed={cam}>{cam ? '📷' : '🚫'} {t(lang, 'camera')}</button>
        <button onClick={toggleShare}>{sharing ? t(lang, 'stopShare') : t(lang, 'share')}</button>
        <button className="danger" onClick={onLeave}>{t(lang, 'leave')}</button>
      </footer>
    </div>
  );
}
