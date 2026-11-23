import { useEffect, useReducer, useRef, useState } from 'react';
import { ConnectionQuality, Room, RoomEvent, Track, type LocalVideoTrack, type Participant, type RemoteParticipant } from 'livekit-client';
import { t, type Lang } from './i18n';
import { BackgroundProcessor, supportsBackgroundProcessors } from '@livekit/track-processors';
import { ApiError, api, type JoinedResult } from './api';
import { MAX_FILE_BYTES, cleanChatText, decode, encode, type Reaction, type Signal } from './signals';
import { CallView } from './call/CallView';
import { Button, Dialog } from './ui';
import { LiveMedia } from './call/LiveMedia';
import { loadLayout, saveLayout } from './call/prefs';
import type { LayoutMode } from './call/layout';
import type { ChatLineView, ManageActions, PanelId, ParticipantView, Quality } from './call/types';

type ChatLine = ChatLineView;

const QUALITY: Record<string, Quality> = {
  [ConnectionQuality.Excellent]: 'excellent',
  [ConnectionQuality.Good]: 'good',
  [ConnectionQuality.Poor]: 'poor',
  [ConnectionQuality.Lost]: 'lost',
};

/** Re-renders the call screen when a participant's tracks, mute state or speaking state change. */
function useParticipantEvents(participants: Participant[]): void {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const refresh = () => bump();
    for (const p of participants) {
      p.on('trackSubscribed', refresh).on('trackUnsubscribed', refresh).on('trackMuted', refresh).on('trackUnmuted', refresh)
        .on('localTrackPublished', refresh).on('localTrackUnpublished', refresh).on('isSpeakingChanged', refresh);
    }
    return () => {
      for (const p of participants) {
        p.off('trackSubscribed', refresh).off('trackUnsubscribed', refresh).off('trackMuted', refresh).off('trackUnmuted', refresh)
          .off('localTrackPublished', refresh).off('localTrackUnpublished', refresh).off('isSpeakingChanged', refresh);
      }
    };
  }, [participants]);
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
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [quality, setQuality] = useState<Quality>('unknown');
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [sharing, setSharing] = useState(false);
  const [locked, setLocked] = useState(false);
  const [requests, setRequests] = useState<import('./api').JoinRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelId>(null);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState(''); // '' = everyone, otherwise a participant identity
  const [unread, setUnread] = useState(0);
  const [hands, setHands] = useState<Record<string, boolean>>({});
  const [myHand, setMyHand] = useState(false);
  const [noiseOn, setNoiseOn] = useState<boolean | null>(null); // as reported by the live microphone track
  const [role, setRole] = useState<'host' | 'cohost' | 'member'>(join.isHost ? 'host' : 'member');
  const [cohostIds, setCohostIds] = useState<string[]>([]);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const [blurOn, setBlurOn] = useState(false);
  const [layout, setLayoutState] = useState<LayoutMode>(loadLayout);
  const [speakerId, setSpeakerId] = useState<string | null>(null);
  const [reactions, setReactions] = useState<Record<string, Reaction>>({});
  const lineId = useRef(0);
  const manages = role !== 'member';
  const chatOpenRef = useRef(false);
  chatOpenRef.current = panel === 'chat';
  const setLayout = (m: LayoutMode) => {
    setLayoutState(m);
    saveLayout(m);
  };
  useParticipantEvents(participants);

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
        // Never yourself: the centre stage is for the others (you are always on your own screen).
        const other = speakers.find((s) => !s.isLocal);
        if (other) setSpeakerId(other.identity);
      })
      .on(RoomEvent.ConnectionQualityChanged, (q, p) => {
        if (p.isLocal) setQuality(QUALITY[q] ?? 'unknown');
      })
      .on(RoomEvent.Reconnecting, () => setReconnecting(true))
      .on(RoomEvent.Reconnected, () => setReconnecting(false))
      .on(RoomEvent.Disconnected, onDisconnected);
    (async () => {
      try {
        // "Firewall mode": all media goes through the TURN relay (for networks that block direct UDP).
        let relay = false;
        try {
          relay = localStorage.getItem('relayMode') === '1';
        } catch {
          /* storage unavailable */
        }
        await room.connect(join.url, join.token, relay ? { rtcConfig: { iceTransportPolicy: 'relay' } } : undefined);
        if (cancelled) return;
        setConnected(true);
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

  // Plain props for the presentational layer. Local participant first: that order is the stable ring order.
  const views: ParticipantView[] = participants.map((p, i) => ({
    id: p.identity,
    name: p.name || p.identity,
    local: i === 0,
    speaking: p.isSpeaking,
    micMuted: p.getTrackPublication(Track.Source.Microphone)?.isMuted !== false,
    camOn: (() => {
      const c = p.getTrackPublication(Track.Source.Camera);
      return !!c?.track && !c.isMuted;
    })(),
    handUp: i === 0 ? myHand : !!hands[p.identity],
    reaction: reactions[p.identity] ?? null,
    isCohost: cohostIds.includes(p.identity),
  }));
  const sharerLk = participants.find((p) => p.getTrackPublication(Track.Source.ScreenShare)?.track);
  const sharer = sharerLk ? (views.find((v) => v.id === sharerLk.identity) ?? null) : null;
  const manage: ManageActions | null = manages
    ? {
        isHost: role === 'host',
        onMute: (id) => void hostCall((tk) => api.mute(tk, code, id)),
        onRemove: (id) => setRemoveTarget({ id, name: views.find((v) => v.id === id)?.name || id }),
        onToggleCohost: (id) => void hostCall((tk) => api.setCohost(tk, code, id, !cohostIds.includes(id)).then(() => setCohostIds((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id])))),
      }
    : null;
  let relay = false;
  try {
    relay = localStorage.getItem('relayMode') === '1';
  } catch {
    /* storage unavailable */
  }

  return (
    <>
    <CallView
      lang={lang}
      title={join.title}
      connected={connected}
      reconnecting={reconnecting}
      quality={quality}
      error={error}
      onDismissError={() => setError(null)}
      participants={views}
      speakerId={speakerId}
      sharer={sharer}
      renderMedia={(kind, pv) => {
        const p = participants.find((x) => x.identity === pv.id);
        return p ? <LiveMedia p={p} kind={kind} local={pv.local} /> : null;
      }}
      role={role}
      manage={manage}
      locked={locked}
      onLock={manages ? () => void hostCall((tk) => api.lock(tk, code, !locked).then((r) => setLocked(r.locked))) : undefined}
      requests={requests.map((r) => ({ id: r.id, name: r.display_name || r.email }))}
      onDecide={(id, admit) => void hostCall((tk) => api.decide(tk, code, id, admit).then(() => setRequests((x) => x.filter((y) => y.id !== id))))}
      mic={mic}
      cam={cam}
      sharing={sharing}
      canShare={typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'}
      handUp={myHand}
      noiseOn={noiseOn}
      blurOn={blurOn}
      relay={relay}
      onMic={() => void toggle('mic')}
      onCam={() => void toggle('cam')}
      onShare={() => void toggleShare()}
      onHand={() => void toggleHand()}
      onReact={(e) => void react(e)}
      onNoise={() => void toggleNoise()}
      onBlur={() => void toggleBlur()}
      onMoreOpen={readNoise}
      onLeave={onLeave}
      panel={panel}
      onPanel={(id) => {
        setPanel(id);
        if (id === 'chat') setUnread(0);
      }}
      unread={unread}
      chat={{ lines, target, onTarget: setTarget, draft, onDraft: setDraft, onSend: (e) => void sendChat(e), onAttach: (f) => void attach(f), onSave: (f) => void saveFile(f) }}
      layout={layout}
      onLayout={setLayout}
    />
    <Dialog
      open={removeTarget !== null}
      onClose={() => setRemoveTarget(null)}
      title={t(lang, 'removeConfirmTitle')}
      closeLabel={t(lang, 'cancel')}
      footer={
        <>
          <Button variant="secondary" data-testid="remove-cancel" onClick={() => setRemoveTarget(null)}>{t(lang, 'cancel')}</Button>
          <Button
            variant="danger"
            data-testid="remove-confirm"
            onClick={() => {
              const id = removeTarget?.id;
              setRemoveTarget(null);
              if (id) void hostCall((tk) => api.remove(tk, code, id));
            }}
          >
            {t(lang, 'removeFromMeeting')}
          </Button>
        </>
      }
    >
      <p>{t(lang, 'removeConfirmBody')} <strong>{removeTarget?.name}</strong></p>
    </Dialog>
    </>
  );
}
