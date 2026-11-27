import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ConnectionQuality, DisconnectReason, Room, RoomEvent, Track, type LocalVideoTrack, type Participant, type RemoteParticipant } from 'livekit-client';
import { t, type Lang } from './i18n';
import { ApiError, api, type GuestMode, type JoinedResult } from './api';
import { MAX_FILE_BYTES, cleanChatText, decode, encode, parseRoomRecording, parseRoomSpotlight, type Reaction, type Signal } from './signals';
import { applyCameraFx, cameraFxSupport, type BgMode } from './call/effects/camera-fx';
import { addCustom, builtInUrl, listCustom, loadFx, removeCustom, saveFx, type BgChoice, type BuiltInBackground, type CamFx } from './call/effects/backgrounds';
import { BackgroundPicker, pickImageFile } from './call/effects/BackgroundPicker';
import { PipWindow, openDocumentPip, pipKind, toggleVideoPip } from './call/Pip';
import { pickFeatured } from './call/layout';
import { fmt } from './call/announcer';
import { useActivity, type ActivityEvent } from './call/activity/useActivity';
import { PollsPanel, QaPanel } from './call/activity/ActivityPanels';
import { isManagerRole, pollsCsv, qaCsv, visibleQuestions } from './call/activity/protocol';
import { useBoard } from './call/board/useBoard';
import { BoardPanel } from './call/board/BoardPanel';
import { fileBase, saveBlob, stamp } from './call/download';
import { CallView } from './call/CallView';
import { Alert, Button, Dialog } from './ui';
import { LiveMedia } from './call/LiveMedia';
import { loadLayout, saveLayout } from './call/prefs';
import type { LayoutMode } from './call/layout';
import { E2eeGate } from './e2ee/E2eeGate';
import { loadStoredKey, storeKey } from './e2ee/keys';
import type { ChatLineView, ManageActions, PanelId, ParticipantView, Quality, RecordingItem } from './call/types';
import { mediaErrorText } from './platform/capacitor';
import { useBackLayer } from './platform/back';
import { holdUpdates } from './platform/update-check';

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

/** The picture URL from a participant's server-set attributes (a random id; anything else is ignored). */
export function avatarOf(attrs: Record<string, string> | undefined): string | null {
  const id = attrs?.['avatar'];
  return id && /^[0-9a-f]{32}$/.test(id) ? `/api/v1/avatars/${id}` : null;
}
const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function Call({
  join,
  code,
  getToken,
  lang,
  onLeave,
  guest = false,
  initialMedia,
  guestMax = 'off',
}: {
  join: JoinedResult;
  code: string;
  getToken: () => Promise<string>;
  lang: Lang;
  /** `ended` is set when the host closed the meeting for everyone (the room was deleted). */
  onLeave: (info?: { ended?: boolean }) => void;
  /** Joined without an account: no member-only calls (role, requests, files, recording) are made and none of their controls shown. */
  guest?: boolean;
  /** What the person chose on the pre-join screen; absent = microphone and camera on. */
  initialMedia?: { mic: boolean; cam: boolean };
  /** The most the organization allows for guests (host side shows the meeting's guest setting within it). */
  guestMax?: GuestMode;
}) {
  const roomRef = useRef<Room | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [quality, setQuality] = useState<Quality>('unknown');
  const [mic, setMic] = useState(initialMedia?.mic ?? true);
  const [cam, setCam] = useState(initialMedia?.cam ?? true);
  const [sharing, setSharing] = useState(false);
  const [locked, setLocked] = useState(false);
  const [guestMode, setGuestMode] = useState<GuestMode | undefined>(join.guestMode);
  const [requests, setRequests] = useState<import('./api').JoinRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelId>(null);
  const [leaveAsk, setLeaveAsk] = useState(false);
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState('');
  const [target, setTarget] = useState(''); // '' = everyone, otherwise a participant identity
  const [unread, setUnread] = useState(0);
  const [hands, setHands] = useState<Record<string, boolean>>({});
  // Job title and department of the other members (owner decision 5): asked once per person, never for guests to see.
  const [cards, setCards] = useState<Record<string, string>>({});
  const askedCards = useRef(new Set<string>());
  useEffect(() => {
    if (guest) return;
    for (const p of participants) {
      const id = p.identity;
      if (!MEMBER_ID.test(id) || askedCards.current.has(id)) continue;
      askedCards.current.add(id);
      void getToken()
        .then((tk) => api.person(tk, id))
        .then((c) => {
          const sub = [c.jobTitle, c.department].filter(Boolean).join(' · ');
          if (sub) setCards((x) => ({ ...x, [id]: sub }));
        })
        .catch(() => undefined);
    }
  });
  const [myHand, setMyHand] = useState(false);
  const [noiseOn, setNoiseOn] = useState<boolean | null>(null); // as reported by the live microphone track
  const [role, setRole] = useState<'host' | 'cohost' | 'member'>(join.isHost ? 'host' : 'member');
  const [cohostIds, setCohostIds] = useState<string[]>([]);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  // Camera effects (virtual background, blur, low light): the choice is remembered on this device and re-applied to every new camera track.
  const [fx, setFxState] = useState<CamFx>(loadFx);
  const [bgOpen, setBgOpen] = useState(false);
  const [customs, setCustoms] = useState<Array<{ id: string; url: string }>>([]);
  const [fxSupport] = useState(cameraFxSupport); // probed once (it creates a throw-away WebGL context)
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const [spotlightId, setSpotlightId] = useState<string | null>(null);
  const [muteAllAsk, setMuteAllAsk] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pipWin, setPipWin] = useState<Window | null>(null);
  const [videoPip, setVideoPip] = useState(false);
  const [pipSupport] = useState(pipKind);
  const [qaSort, setQaSort] = useState<'top' | 'new'>('top');
  const [layout, setLayoutState] = useState<LayoutMode>(loadLayout);
  const [speakerId, setSpeakerId] = useState<string | null>(null);
  const [reactions, setReactions] = useState<Record<string, Reaction>>({});
  // Recording: `recOn` is the consent truth (server-set room metadata, read on connect and on every change, so late joiners see it too).
  const [recOn, setRecOn] = useState(false);
  const [recStatus, setRecStatus] = useState({ enabled: false, e2ee: false });
  const [recBusy, setRecBusy] = useState(false);
  const [recItems, setRecItems] = useState<RecordingItem[]>([]);
  // End-to-end encryption: the key comes from this tab (link fragment, kept in sessionStorage), never from the server.
  const [e2eeKey, setE2eeKey] = useState<string | null>(() => (join.e2ee ? loadStoredKey(code) : null));
  const [e2eeMod, setE2eeMod] = useState<typeof import('./e2ee/provider') | null>(null);
  const [e2eeOn, setE2eeOn] = useState(false);
  const [e2eeUnsupported, setE2eeUnsupported] = useState(false);
  const lineId = useRef(0);
  const manages = role !== 'member';
  const chatOpenRef = useRef(false);
  chatOpenRef.current = panel === 'chat';
  const setLayout = (m: LayoutMode) => {
    setLayoutState(m);
    saveLayout(m);
  };
  useParticipantEvents(participants);
  // Android Back: the innermost open thing closes first (a menu, then a side panel); with nothing open it asks before leaving.
  // Registered first, so every layer opened later is asked before it.
  const gateOpen = join.e2ee === true && (!e2eeKey || e2eeUnsupported);
  useBackLayer(true, () => (gateOpen ? onLeave() : setLeaveAsk(true)));
  useBackLayer(panel !== null, () => setPanel(null));
  useEffect(() => holdUpdates(), []); // a new deploy never reloads the page during a call

  // The E2EE provider (and its worker) is a separate chunk that only E2EE meetings download.
  useEffect(() => {
    if (!join.e2ee || !e2eeKey || e2eeMod) return;
    let stop = false;
    import('./e2ee/provider').then((m) => !stop && setE2eeMod(m)).catch(() => !stop && setE2eeUnsupported(true));
    return () => {
      stop = true;
    };
  }, [join.e2ee, e2eeKey, e2eeMod]);

  useEffect(() => {
    // An encrypted meeting is never joined without its key (the gate below is shown instead) and never without the
    // encryption code loaded: there is no plaintext fallback.
    if (join.e2ee && (!e2eeKey || !e2eeMod)) return;
    // Browser audio DSP is on by default; the toggle below restarts the microphone with the chosen setting.
    let e2ee: ReturnType<NonNullable<typeof e2eeMod>['createE2eeRoomOptions']> | null = null;
    let room: Room;
    try {
      e2ee = join.e2ee && e2eeMod && e2eeKey ? e2eeMod.createE2eeRoomOptions(e2eeKey) : null;
      room = new Room({
        adaptiveStream: true,
        dynacast: true,
        audioCaptureDefaults: { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
        ...(e2ee?.options ?? {}),
      });
    } catch {
      // The browser cannot encrypt media (Room refuses to be built): say so, do not fall back to an unencrypted call.
      e2ee?.dispose();
      setE2eeUnsupported(true);
      return;
    }
    roomRef.current = room;
    let keyErrorShown = false;
    if (e2ee) {
      room
        .on(RoomEvent.EncryptionError, () => {
          if (cancelled || keyErrorShown) return;
          keyErrorShown = true;
          setError(t(lang, 'e2eeWrongKey'));
        })
        .on(RoomEvent.ParticipantEncryptionStatusChanged, (enabled: boolean, p?: Participant) => {
          if (!cancelled && p?.isLocal) setE2eeOn(enabled);
        });
    }
    const sync = () => setParticipants([room.localParticipant, ...Array.from(room.remoteParticipants.values())]);
    // Only a disconnect of the room that is still current may leave the call. React StrictMode mounts,
    // unmounts and remounts this effect in development; the discarded room's disconnect must be ignored.
    let cancelled = false;
    const onDisconnected = (reason?: DisconnectReason) => {
      if (!cancelled) onLeave(reason === DisconnectReason.ROOM_DELETED ? { ended: true } : undefined);
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
      .on(RoomEvent.RoomMetadataChanged, (metadata: string) => {
        setRecOn(parseRoomRecording(metadata));
        setSpotlightId(parseRoomSpotlight(metadata));
      })
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
        if (e2ee) {
          // Order matters: the key is in the provider and encryption is on BEFORE connecting and before any track is
          // published, so no frame leaves this browser unencrypted. A failure here throws and nothing connects.
          await e2ee.installKey();
          await room.setE2EEEnabled(true);
        }
        await room.connect(join.url, join.token, relay ? { rtcConfig: { iceTransportPolicy: 'relay' } } : undefined);
        if (cancelled) return;
        setConnected(true);
        setRecOn(parseRoomRecording(room.metadata));
        setSpotlightId(parseRoomSpotlight(room.metadata));
        sync();
        try {
          await room.localParticipant.setMicrophoneEnabled(initialMedia?.mic ?? true);
          await room.localParticipant.setCameraEnabled(initialMedia?.cam ?? true);
          const v = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack?.mediaStreamTrack.getSettings().noiseSuppression;
          setNoiseOn(typeof v === 'boolean' ? v : null);
        } catch {
          setError(mediaErrorText(lang));
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
      void room.disconnect().finally(() => e2ee?.dispose());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [join.token, e2eeKey, e2eeMod]);

  // Role follows promotions and demotions while connected; managers also poll the waiting room and co-host list.
  useEffect(() => {
    if (guest) return;
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
  }, [code, getToken, guest]);

  // Whether recording is available here and whether this meeting is end-to-end encrypted (the record button depends on it).
  useEffect(() => {
    if (guest) return;
    let stop = false;
    void (async () => {
      try {
        const st = await api.recordingStatus(await getToken(), code);
        if (!stop) setRecStatus({ enabled: st.enabled, e2ee: st.e2ee });
      } catch {
        /* recording stays unavailable */
      }
    })();
    return () => {
      stop = true;
    };
  }, [code, getToken]);

  // The person's own background images: decoded once from this browser's storage into object URLs (never uploaded).
  useEffect(() => {
    let stop = false;
    let urls: string[] = [];
    void listCustom().then((list) => {
      if (stop) return;
      urls = list.map((c) => URL.createObjectURL(c.blob));
      setCustoms(list.map((c, i) => ({ id: c.id, url: urls[i]! })));
    });
    return () => {
      stop = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  // Applies the effects to the live camera track whenever the choice, the camera or the connection changes.
  useEffect(() => {
    const room = roomRef.current;
    if (!connected || !cam || !room) return;
    const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.videoTrack as LocalVideoTrack | undefined;
    if (!track) return;
    const bg: BgMode =
      fx.bg === 'blur'
        ? { kind: 'blur' }
        : fx.bg.startsWith('img:')
          ? { kind: 'image', url: builtInUrl(fx.bg.slice(4) as BuiltInBackground) }
          : fx.bg.startsWith('custom:')
            ? (() => {
                const c = customs.find((x) => `custom:${x.id}` === fx.bg);
                return c ? ({ kind: 'image', url: c.url } as const) : ({ kind: 'none' } as const);
              })()
            : { kind: 'none' };
    const wanted = { bg: fxSupport.background ? bg : ({ kind: 'none' } as const), lowLight: fx.lowLight && fxSupport.lowLight };
    applyCameraFx(track, wanted).catch(() => {
      setError(t(lang, 'errBlur'));
      setFxState((f) => ({ ...f, bg: 'none' }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, cam, fx, customs]);

  // Picture-in-picture: closes with the call; Chrome may open it by itself when the tab is hidden during a call.
  useEffect(() => () => pipWin?.close(), [pipWin]);
  useEffect(() => {
    const onLeavePip = () => setVideoPip(false);
    document.addEventListener('leavepictureinpicture', onLeavePip, true);
    return () => document.removeEventListener('leavepictureinpicture', onLeavePip, true);
  }, []);

  // Polls, Q&A and the whiteboard: data-channel state in the browsers only; the API records that events happened, never content.
  const recordActivity = useCallback(
    (e: ActivityEvent) => {
      if (guest) return;
      void getToken()
        .then((tk) => api.activity(tk, code, e))
        .catch(() => undefined);
    },
    [guest, getToken, code],
  );
  const liveRoom = connected ? roomRef.current : null;
  const activity = useActivity(liveRoom, connected, panel, recordActivity);
  const board = useBoard(liveRoom, connected, panel === 'board', (grant) => recordActivity(grant ? 'board.draw.grant' : 'board.draw.revoke'));

  const room = roomRef.current;
  if (join.e2ee && (!e2eeKey || e2eeUnsupported)) {
    return (
      <E2eeGate
        lang={lang}
        title={join.title}
        unsupported={e2eeUnsupported}
        onKey={(k) => {
          storeKey(code, k);
          setE2eeKey(k);
        }}
        onLeave={onLeave}
      />
    );
  }
  const toggle = async (kind: 'mic' | 'cam') => {
    if (!room) return;
    try {
      if (kind === 'mic') {
        await room.localParticipant.setMicrophoneEnabled(!mic);
        setMic(!mic);
      } else {
        await room.localParticipant.setCameraEnabled(!cam);
        setCam(!cam); // the effects are re-applied to the new camera track by the effect above
      }
    } catch {
      setError(mediaErrorText(lang));
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
      setError(mediaErrorText(lang));
    }
  };
  // Background effects run in the browser (MediaPipe segmentation, our own origin); low light is a GPU pass. See call/effects.
  const setFx = (next: CamFx) => {
    setFxState(next);
    saveFx(next);
  };
  const chooseBg = (bg: BgChoice) => {
    if (bg !== 'none' && !fxSupport.background) {
      setError(t(lang, 'errBlur'));
      return;
    }
    setFx({ ...fx, bg });
  };
  const toggleBlur = () => chooseBg(fx.bg === 'blur' ? 'none' : 'blur');
  const uploadBg = async () => {
    const file = await pickImageFile();
    if (!file) return;
    try {
      const c = await addCustom(file);
      const url = URL.createObjectURL(c.blob);
      const kept = await listCustom();
      setCustoms((list) => [...list.filter((x) => kept.some((k) => k.id === x.id)), { id: c.id, url }]);
      chooseBg(`custom:${c.id}`);
    } catch {
      setError(t(lang, 'fxErrImage'));
    }
  };
  const dropCustom = async (id: string) => {
    await removeCustom(id).catch(() => undefined);
    setCustoms((list) => list.filter((x) => x.id !== id));
    if (fx.bg === `custom:${id}`) setFx({ ...fx, bg: 'none' });
  };
  const togglePip = async () => {
    try {
      if (pipSupport === 'document') {
        if (pipWin) {
          pipWin.close();
          return;
        }
        const w = await openDocumentPip();
        if (!w) return;
        w.addEventListener('pagehide', () => setPipWin(null), { once: true });
        setPipWin(w);
      } else if (pipSupport === 'video') {
        setVideoPip(await toggleVideoPip());
      }
    } catch {
      /* refused by the browser (no user gesture, or nothing to show) */
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
  const loadRecordings = async () => {
    if (!manages || !recStatus.enabled) return;
    try {
      setRecItems(await api.recordings(await getToken(), code));
    } catch {
      /* the list is a convenience; the badge does not depend on it */
    }
  };
  const recError = (e: unknown): string => {
    const status = e instanceof ApiError ? e.status : 0;
    if (status === 503) return t(lang, 'clRecErrOff');
    if (status === 409) return t(lang, 'clRecErrBusy');
    return t(lang, 'clRecErrGeneric');
  };
  const toggleRecording = async () => {
    if (recBusy) return;
    setRecBusy(true);
    try {
      const tk = await getToken();
      if (recOn) await api.stopRecording(tk, code);
      else await api.startRecording(tk, code);
      await loadRecordings();
    } catch (e) {
      setError(recError(e));
    } finally {
      setRecBusy(false);
    }
  };
  const saveRecording = async (id: string) => {
    try {
      const blob = await api.downloadRecording(await getToken(), id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${join.title.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 60) || 'recording'}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setError(t(lang, 'clRecErrGeneric'));
    }
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
    name: (p.name || p.identity) + (p.identity.startsWith('guest:') ? ` (${t(lang, 'hGuestLabel')})` : ''),
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
    pinned: pinnedId === p.identity,
    spotlit: spotlightId === p.identity,
    ...(avatarOf(p.attributes) ? { avatarUrl: avatarOf(p.attributes)! } : {}),
    ...(cards[p.identity] ? { subtitle: cards[p.identity] } : {}),
  }));
  const sharerLk = participants.find((p) => p.getTrackPublication(Track.Source.ScreenShare)?.track);
  const sharer = sharerLk ? (views.find((v) => v.id === sharerLk.identity) ?? null) : null;
  const manage: ManageActions | null = manages
    ? {
        isHost: role === 'host',
        onMute: (id) => void hostCall((tk) => api.mute(tk, code, id)),
        onRemove: (id) => setRemoveTarget({ id, name: views.find((v) => v.id === id)?.name || id }),
        onToggleCohost: (id) => void hostCall((tk) => api.setCohost(tk, code, id, !cohostIds.includes(id)).then(() => setCohostIds((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id])))),
        onSpotlight: (id) => void hostCall((tk) => api.spotlight(tk, code, id).then((r) => setSpotlightId(r.spotlight))),
        onMuteAll: () => setMuteAllAsk(true),
      }
    : null;
  const nameOf = (id: string) => {
    const p = participants.find((x) => x.identity === id);
    return p ? p.name || p.identity : id;
  };
  // The person shown in the picture-in-picture window: the same choice as the centre of the stage.
  const pipFeaturedId = pickFeatured(
    participants.map((x) => x.identity),
    { sharerId: sharerLk?.identity, speakerId, spotlightId, pinnedId },
  );
  const pipFeatured = participants.find((x) => x.identity === pipFeaturedId && !x.isLocal) ?? participants.find((x) => !x.isLocal) ?? null;
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
      requests={requests.map((r) => ({ id: r.id, name: (r.display_name || r.email || '') + (r.guest ? ` (${t(lang, 'hGuestLabel')})` : '') }))}
      onDecide={(id, admit) => void hostCall((tk) => api.decide(tk, code, id, admit).then(() => setRequests((x) => x.filter((y) => y.id !== id))))}
      mic={mic}
      cam={cam}
      sharing={sharing}
      canShare={typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getDisplayMedia === 'function'}
      handUp={myHand}
      noiseOn={noiseOn}
      blurOn={fx.bg === 'blur'}
      relay={relay}
      onMic={() => void toggle('mic')}
      onCam={() => void toggle('cam')}
      onShare={() => void toggleShare()}
      onHand={() => void toggleHand()}
      onReact={(e) => void react(e)}
      onNoise={() => void toggleNoise()}
      onBlur={toggleBlur}
      onBackground={() => setBgOpen(true)}
      lowLightOn={fx.lowLight}
      onLowLight={fxSupport.lowLight ? () => setFx({ ...fx, lowLight: !fx.lowLight }) : undefined}
      pip={pipSupport ? { active: !!pipWin || videoPip, onToggle: () => void togglePip() } : undefined}
      spotlightId={spotlightId}
      pinnedId={pinnedId}
      onPin={(id) => setPinnedId((cur) => (cur === id ? null : id))}
      notices={
        <>
          {notice ? <Alert tone="info" className="dv-notice" onDismiss={() => setNotice(null)} dismissLabel={t(lang, 'uiDismiss')}>{notice}</Alert> : null}
          {activity.lastPoll && panel !== 'polls' ? (
            <Alert tone="info" className="dv-notice" onDismiss={activity.clearLastPoll} dismissLabel={t(lang, 'uiDismiss')}>
              <span data-testid="poll-notice">{fmt(t(lang, 'annPoll'), { q: activity.lastPoll.q })}</span>{' '}
              <Button
                size="sm"
                variant="primary"
                data-testid="poll-notice-open"
                onClick={() => {
                  setPanel('polls');
                  activity.markSeen('polls');
                  activity.clearLastPoll();
                }}
              >
                {t(lang, 'pollVote')}
              </Button>
            </Alert>
          ) : null}
        </>
      }
      onMoreOpen={() => {
        readNoise();
        void loadRecordings();
      }}
      // The host side chooses between leaving (the others carry on) and ending the meeting for everyone.
      onLeave={manages && !guest ? () => setLeaveAsk(true) : onLeave}
      panel={panel}
      onPanel={(id) => {
        setPanel(id);
        if (id === 'chat') setUnread(0);
        if (id === 'polls') {
          activity.markSeen('polls');
          activity.clearLastPoll();
        }
        if (id === 'qa') activity.markSeen('qa');
        if (id === 'board') board.clearActivity();
      }}
      activities={{ polls: activity.unseen.polls, qa: activity.unseen.qa, board: board.activity }}
      activityPanel={
        panel === 'polls' ? (
          <PollsPanel
            lang={lang}
            polls={activity.state.polls}
            manager={activity.manager}
            managersPresent={activity.managersPresent}
            onCreate={(poll) => activity.send({ t: 'poll.open', poll })}
            onEnd={(id) => activity.send({ t: 'poll.close', id })}
            onVote={(id, choices) => activity.send({ t: 'poll.vote', id, choices })}
            onCsv={() => saveBlob(new Blob([pollsCsv(activity.state.polls, nameOf)], { type: 'text/csv;charset=utf-8' }), `${fileBase(join.title, 'meeting')}-polls-${stamp()}.csv`)}
            onClose={() => setPanel(null)}
          />
        ) : panel === 'qa' ? (
          <QaPanel
            lang={lang}
            questions={visibleQuestions(activity.state.qa, activity.manager, qaSort)}
            manager={activity.manager}
            anonAllowed={activity.state.anon}
            myId={room?.localParticipant.identity ?? ''}
            sort={qaSort}
            onSort={setQaSort}
            onAsk={(text, anon) => activity.send({ t: 'qa.ask', id: crypto.randomUUID().toLowerCase(), text, anon })}
            onVote={(id, up) => activity.send({ t: 'qa.vote', id, up })}
            onMod={(id, op) => activity.send({ t: 'qa.mod', id, op })}
            onAnonAllowed={(on) => activity.send({ t: 'qa.cfg', anon: on })}
            onCsv={() => saveBlob(new Blob([qaCsv(activity.state.qa, t(lang, 'qaAnonName'))], { type: 'text/csv;charset=utf-8' }), `${fileBase(join.title, 'meeting')}-qa-${stamp()}.csv`)}
            onClose={() => setPanel(null)}
          />
        ) : panel === 'board' ? (
          <BoardPanel
            lang={lang}
            board={board}
            others={participants.filter((x) => !x.isLocal).map((x) => ({ id: x.identity, name: x.name || x.identity, manager: isManagerRole(x.attributes?.role) }))}
            title={join.title}
            e2ee={join.e2ee === true}
            onClose={() => setPanel(null)}
          />
        ) : null
      }
      unread={unread}
      chat={{ lines, target, onTarget: setTarget, draft, onDraft: setDraft, onSend: (e) => void sendChat(e), onAttach: (f) => void attach(f), onSave: (f) => void saveFile(f), noFiles: join.e2ee === true || guest, guest }}
      layout={layout}
      onLayout={setLayout}
      e2ee={join.e2ee ? { on: e2eeOn } : undefined}
      guests={
        !guest && guestMode !== undefined && (guestMax !== 'off' || guestMode !== 'off')
          ? { value: guestMode, max: guestMax, onChange: (m) => void hostCall((tk) => api.setGuests(tk, code, m).then((r) => setGuestMode(r.guest_mode))) }
          : undefined
      }
      recording={{
        on: recOn,
        e2ee: recStatus.e2ee,
        busy: recBusy,
        onToggle: manages && recStatus.enabled ? () => void toggleRecording() : undefined,
        items: recItems,
        onDownload: (id) => void saveRecording(id),
      }}
    />
    <BackgroundPicker
      lang={lang}
      open={bgOpen}
      onClose={() => setBgOpen(false)}
      value={fx.bg}
      onChange={chooseBg}
      customs={customs}
      onUpload={() => void uploadBg()}
      onRemoveCustom={(id) => void dropCustom(id)}
      supported={fxSupport.background}
      camOn={cam}
    />
    {pipWin ? (
      <PipWindow
        win={pipWin}
        lang={lang}
        featured={pipFeatured}
        name={pipFeatured ? pipFeatured.name || pipFeatured.identity : ''}
        mic={mic}
        cam={cam}
        onMic={() => void toggle('mic')}
        onCam={() => void toggle('cam')}
        onLeave={() => {
          pipWin.close();
          if (manages && !guest) {
            window.focus();
            setLeaveAsk(true);
          } else onLeave();
        }}
      />
    ) : null}
    <Dialog
      open={muteAllAsk}
      onClose={() => setMuteAllAsk(false)}
      title={t(lang, 'muteAllTitle')}
      closeLabel={t(lang, 'cancel')}
      footer={
        <>
          <Button variant="secondary" data-testid="mute-all-cancel" onClick={() => setMuteAllAsk(false)}>{t(lang, 'cancel')}</Button>
          <Button
            variant="danger"
            data-testid="mute-all-confirm"
            onClick={() => {
              setMuteAllAsk(false);
              void hostCall((tk) => api.muteAll(tk, code).then((r) => setNotice(fmt(t(lang, 'muteAllDone'), { n: r.muted }))));
            }}
          >
            {t(lang, 'muteAll')}
          </Button>
        </>
      }
    >
      <p>{t(lang, 'muteAllBody')}</p>
    </Dialog>
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
    <Dialog
      open={leaveAsk}
      onClose={() => setLeaveAsk(false)}
      title={t(lang, 'leaveConfirmTitle')}
      closeLabel={t(lang, 'leaveStay')}
      footer={
        <>
          <Button variant="secondary" data-testid="leave-stay" onClick={() => setLeaveAsk(false)}>{t(lang, 'leaveStay')}</Button>
          <Button variant={manages && !guest ? 'secondary' : 'danger'} data-testid="leave-confirm" onClick={() => { setLeaveAsk(false); onLeave(); }}>{t(lang, 'leave')}</Button>
          {manages && !guest ? (
            <Button
              variant="danger"
              data-testid="end-for-all"
              onClick={() => {
                setLeaveAsk(false);
                void hostCall((tk) => api.endMeeting(tk, code)).finally(onLeave);
              }}
            >
              {t(lang, 'endForAll')}
            </Button>
          ) : null}
        </>
      }
    >
      <p>{t(lang, manages && !guest ? 'leaveHostBody' : 'leaveConfirmBody')}</p>
    </Dialog>
    </>
  );
}
