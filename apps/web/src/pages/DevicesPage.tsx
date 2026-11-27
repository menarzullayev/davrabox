import { useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionCheck } from 'livekit-client';
import type { Lang } from '../i18n';
import { t } from '../i18n';
import { Alert, Badge, Button, IconCamera, IconMic, IconVolume, IconGlobe, Select, type Tone } from '../ui';
import { mediaErrorText } from '../platform/capacitor';
import { holdUpdates } from '../platform/update-check';
import type { HomeApi } from '../home/homeApi';
import { tx } from '../home/text';

type Kind = 'videoinput' | 'audioinput' | 'audiooutput';
type Result = 'pending' | 'running' | 'pass' | 'warn' | 'fail' | 'skipped';

/** One network check of the media server, in the order they run. */
export const CHECKS = [
  { id: 'ws', label: 'dvCheckWs', run: 'checkWebsocket' },
  { id: 'rtc', label: 'dvCheckRtc', run: 'checkWebRTC' },
  { id: 'turn', label: 'dvCheckTurn', run: 'checkTURN' },
  { id: 'proto', label: 'dvCheckProto', run: 'checkConnectionProtocol' },
  { id: 'audio', label: 'dvCheckAudio', run: 'checkPublishAudio' },
  { id: 'video', label: 'dvCheckVideo', run: 'checkPublishVideo' },
] as const;
type CheckId = (typeof CHECKS)[number]['id'];

/** LiveKit's CheckStatus (IDLE 0, RUNNING 1, SKIPPED 2, SUCCESS 3, FAILED 4) plus warnings in the logs. */
export function resultOf(info: { status: number; logs: Array<{ level: string }> }): Result {
  if (info.status === 1) return 'running';
  if (info.status === 2) return 'skipped';
  if (info.status === 4) return 'fail';
  if (info.status === 3) return info.logs.some((l) => l.level === 'warning' || l.level === 'error') ? 'warn' : 'pass';
  return 'pending';
}

const TONE: Record<Result, Tone> = { pending: 'neutral', running: 'accent', pass: 'success', warn: 'warning', fail: 'danger', skipped: 'neutral' };
const LABEL: Record<Result, 'dvPending' | 'dvNetRunning' | 'dvPass' | 'dvWarn' | 'dvFail' | 'dvSkipped'> = {
  pending: 'dvPending',
  running: 'dvNetRunning',
  pass: 'dvPass',
  warn: 'dvWarn',
  fail: 'dvFail',
  skipped: 'dvSkipped',
};

/** Root-mean-square level of one analyser frame, 0..1. */
export function rmsLevel(samples: Uint8Array): number {
  let sum = 0;
  for (const v of samples) {
    const x = (v - 128) / 128;
    sum += x * x;
  }
  return samples.length ? Math.min(1, Math.sqrt(sum / samples.length) * 3) : 0;
}

async function listDevices(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  } catch {
    return [];
  }
}

export interface DevicesPageProps {
  lang: Lang;
  api: Pick<HomeApi, 'connectionTest'>;
  /** The person finished the check ("Get started" step). */
  onDone: () => void;
}

/**
 * "Test your devices" (owner decision 6): camera with a choice of device, microphone level, a speaker test tone, and a real
 * connection to the media server (signalling, WebRTC over UDP and TCP, TURN, publishing). Linked from home and the checklist.
 */
export function DevicesPage({ lang, api, onDone }: DevicesPageProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const camStream = useRef<MediaStream | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const audioCtx = useRef<AudioContext | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cam, setCam] = useState('');
  const [mic, setMic] = useState('');
  const [out, setOut] = useState('');
  const [camOk, setCamOk] = useState<boolean | null>(null);
  const [micOk, setMicOk] = useState<boolean | null>(null);
  const [level, setLevel] = useState(0);
  const [heardMic, setHeardMic] = useState(false);
  const [silent, setSilent] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [heard, setHeard] = useState(false);
  const [checks, setChecks] = useState<Record<CheckId, Result>>(() => Object.fromEntries(CHECKS.map((c) => [c.id, 'pending'])) as Record<CheckId, Result>);
  const [netState, setNetState] = useState<'idle' | 'running' | 'done' | 'failed'>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => holdUpdates(), []);

  const refreshDevices = useCallback(async () => setDevices(await listDevices()), []);
  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

  // Camera: (re)opened whenever the choice changes.
  useEffect(() => {
    let stop = false;
    void (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: cam ? { deviceId: { exact: cam } } : true });
        if (stop) return s.getTracks().forEach((x) => x.stop());
        camStream.current?.getTracks().forEach((x) => x.stop());
        camStream.current = s;
        if (videoRef.current) videoRef.current.srcObject = s;
        setCamOk(true);
        void refreshDevices(); // labels appear once permission is given
      } catch {
        if (!stop) {
          setCamOk(false);
          setProblem(mediaErrorText(lang));
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, [cam, lang, refreshDevices]);

  // Microphone: a level meter from an analyser; "silent" after a few seconds without any sound.
  useEffect(() => {
    let stop = false;
    let raf = 0;
    let quietSince = performance.now();
    void (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: mic ? { deviceId: { exact: mic } } : true });
        if (stop) return s.getTracks().forEach((x) => x.stop());
        micStream.current?.getTracks().forEach((x) => x.stop());
        micStream.current = s;
        setMicOk(true);
        void refreshDevices();
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        const ctx = audioCtx.current ?? new Ctx();
        audioCtx.current = ctx;
        const src = ctx.createMediaStreamSource(s);
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        src.connect(an);
        const buf = new Uint8Array(an.fftSize);
        const tick = () => {
          an.getByteTimeDomainData(buf);
          const v = rmsLevel(buf);
          setLevel(v);
          if (v > 0.08) {
            setHeardMic(true);
            setSilent(false);
            quietSince = performance.now();
          } else if (performance.now() - quietSince > 6000) setSilent(true);
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        if (!stop) {
          setMicOk(false);
          setProblem(mediaErrorText(lang));
        }
      }
    })();
    return () => {
      stop = true;
      cancelAnimationFrame(raf);
    };
  }, [mic, lang, refreshDevices]);

  // Release everything on leave.
  useEffect(
    () => () => {
      camStream.current?.getTracks().forEach((x) => x.stop());
      micStream.current?.getTracks().forEach((x) => x.stop());
      void audioCtx.current?.close().catch(() => undefined);
    },
    [],
  );

  const canPickOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

  const playTone = async () => {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx || playing) return;
    setPlaying(true);
    try {
      const ctx = audioCtx.current ?? new Ctx();
      audioCtx.current = ctx;
      await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 523.25;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.4);
      osc.connect(gain);
      // Through an <audio> element, so the chosen output device (setSinkId) is the one that plays it.
      const dest = ctx.createMediaStreamDestination();
      gain.connect(dest);
      const el = new Audio();
      el.srcObject = dest.stream;
      if (out && canPickOutput) await (el as HTMLAudioElement & { setSinkId: (id: string) => Promise<void> }).setSinkId(out).catch(() => undefined);
      await el.play().catch(() => gain.connect(ctx.destination));
      osc.start();
      osc.stop(ctx.currentTime + 1.5);
      await new Promise((r) => setTimeout(r, 1600));
      el.srcObject = null;
    } finally {
      setPlaying(false);
    }
  };

  const runNetwork = async () => {
    setNetState('running');
    setChecks(Object.fromEntries(CHECKS.map((c) => [c.id, 'pending'])) as Record<CheckId, Result>);
    let ticket: { url: string; token: string };
    try {
      ticket = await api.connectionTest();
    } catch {
      setNetState('failed');
      return;
    }
    try {
      const cc = new ConnectionCheck(ticket.url, ticket.token);
      for (const c of CHECKS) {
        setChecks((s) => ({ ...s, [c.id]: 'running' }));
        let r: Result;
        try {
          r = resultOf(await cc[c.run]());
        } catch {
          r = 'fail';
        }
        setChecks((s) => ({ ...s, [c.id]: r }));
      }
      setNetState('done');
    } catch {
      setNetState('failed');
    }
  };

  const opts = (kind: Kind) => devices.filter((d) => d.kind === kind && d.deviceId);
  const label = (d: MediaDeviceInfo, i: number) => d.label || `${t(lang, d.kind === 'videoinput' ? 'dvCamera' : d.kind === 'audioinput' ? 'dvMic' : 'dvSpeaker')} ${i + 1}`;
  const results = Object.values(checks);
  const allGood = netState === 'done' && results.every((r) => r === 'pass' || r === 'skipped');

  return (
    <main id="hm-main" className="home hm-main dv-page" tabIndex={-1} data-testid="devices-page">
      <header className="pg-head">
        <h1 className="pg-title">{tx(lang, 'dvTitle')}</h1>
        <p className="pg-lead">{tx(lang, 'dvLead')}</p>
      </header>
      {problem ? (
        <div className="hm-error">
          <Alert tone="warning">
            <span className="dvp-problem">
              <span>{problem}</span>
              <span>{tx(lang, 'dvPermission')}</span>
            </span>
          </Alert>
        </div>
      ) : null}
      <div className="dvp-grid">
        <section className="hm-card dvp-card" aria-labelledby="dv-cam-h">
          <h2 className="hm-card__title dvp-h" id="dv-cam-h">
            <IconCamera size={20} />
            {tx(lang, 'dvCamera')}
          </h2>
          <div className="dvp-preview">
            <video ref={videoRef} autoPlay muted playsInline className={camOk ? 'dvp-video' : 'dvp-video dvp-video--off'} data-testid="dv-video" />
            {!camOk ? <p className="dvp-off">{tx(lang, 'hPreCamOff')}</p> : null}
          </div>
          {opts('videoinput').length ? (
            <Select label={tx(lang, 'dvDevice')} value={cam || opts('videoinput')[0]!.deviceId} data-testid="dv-cam-select" onChange={(e) => setCam(e.target.value)}>
              {opts('videoinput').map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {label(d, i)}
                </option>
              ))}
            </Select>
          ) : (
            <p className="pg-item__meta">{tx(lang, 'dvNoDevices')}</p>
          )}
        </section>

        <section className="hm-card dvp-card" aria-labelledby="dv-mic-h">
          <h2 className="hm-card__title dvp-h" id="dv-mic-h">
            <IconMic size={20} />
            {tx(lang, 'dvMic')}
          </h2>
          <p className="hm-card__lead">{tx(lang, 'dvSpeak')}</p>
          <div className="dvp-meter" role="meter" aria-label={tx(lang, 'dvLevel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)} data-testid="dv-level" data-heard={heardMic ? '' : undefined}>
            <span style={{ inlineSize: `${Math.round(level * 100)}%` }} />
          </div>
          {silent && micOk ? <p className="pj__problem">{tx(lang, 'dvMicSilent')}</p> : null}
          {opts('audioinput').length ? (
            <Select label={tx(lang, 'dvDevice')} value={mic || opts('audioinput')[0]!.deviceId} data-testid="dv-mic-select" onChange={(e) => setMic(e.target.value)}>
              {opts('audioinput').map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {label(d, i)}
                </option>
              ))}
            </Select>
          ) : (
            <p className="pg-item__meta">{tx(lang, 'dvNoDevices')}</p>
          )}
        </section>

        <section className="hm-card dvp-card" aria-labelledby="dv-spk-h">
          <h2 className="hm-card__title dvp-h" id="dv-spk-h">
            <IconVolume size={20} />
            {tx(lang, 'dvSpeaker')}
          </h2>
          {canPickOutput && opts('audiooutput').length ? (
            <Select label={tx(lang, 'dvDevice')} value={out || opts('audiooutput')[0]!.deviceId} data-testid="dv-out-select" onChange={(e) => setOut(e.target.value)}>
              {opts('audiooutput').map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {label(d, i)}
                </option>
              ))}
            </Select>
          ) : (
            <p className="pg-item__meta">{tx(lang, 'dvNoOutputChoice')}</p>
          )}
          <div className="pg-actions">
            <Button variant="secondary" loading={playing} data-testid="dv-play" onClick={() => void playTone()}>
              {tx(lang, playing ? 'dvPlaying' : 'dvPlay')}
            </Button>
            <Button variant={heard ? 'primary' : 'ghost'} aria-pressed={heard} data-testid="dv-heard" onClick={() => setHeard(true)}>
              {tx(lang, 'dvHeard')}
            </Button>
          </div>
        </section>

        <section className="hm-card dvp-card dvp-net" aria-labelledby="dv-net-h">
          <h2 className="hm-card__title dvp-h" id="dv-net-h">
            <IconGlobe size={20} />
            {tx(lang, 'dvNet')}
          </h2>
          <p className="hm-card__lead">{tx(lang, 'dvNetLead')}</p>
          <ul className="pg-list" data-testid="dv-checks">
            {CHECKS.map((c) => (
              <li key={c.id} className="dvp-check" data-testid={`dv-check-${c.id}`} data-result={checks[c.id]}>
                <span>{tx(lang, c.label)}</span>
                <Badge tone={TONE[checks[c.id]]}>{tx(lang, LABEL[checks[c.id]])}</Badge>
              </li>
            ))}
          </ul>
          {netState === 'failed' ? <Alert tone="danger">{tx(lang, 'dvNetFailed')}</Alert> : null}
          {netState === 'done' ? (
            <div role="status" data-testid="dv-net-summary">
              <Alert tone={allGood ? 'success' : 'warning'}>{tx(lang, allGood ? 'dvAllGood' : 'dvSomeIssues')}</Alert>
            </div>
          ) : null}
          <div className="pg-actions">
            <Button variant="secondary" loading={netState === 'running'} data-testid="dv-net-run" onClick={() => void runNetwork()}>
              {tx(lang, netState === 'idle' ? 'dvNetRun' : netState === 'running' ? 'dvNetRunning' : 'dvNetAgain')}
            </Button>
          </div>
        </section>
      </div>
      <div className="pg-actions dvp-foot">
        <Button variant="primary" size="lg" data-testid="dv-done" onClick={onDone}>
          {tx(lang, 'dvDone')}
        </Button>
        <a className="pj__help" href="/help#guide-devices" target="_blank" rel="noopener">
          {tx(lang, 'asCameraHelp')}
        </a>
      </div>
    </main>
  );
}
