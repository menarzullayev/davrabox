import { useEffect, useRef, useState } from 'react';
import type { Lang } from '../i18n';
import { Button, Checkbox, Switch } from '../ui';
import { mediaErrorText } from '../platform/capacitor';
import { tx } from './text';

export interface MediaChoice {
  mic: boolean;
  cam: boolean;
}

/** The "do not show this again" choice, kept in this browser only. */
export const SKIP_PREJOIN_KEY = 'skipPreJoin';
export function readSkipPreJoin(): boolean {
  try {
    return localStorage.getItem(SKIP_PREJOIN_KEY) === '1';
  } catch {
    return false;
  }
}
function writeSkipPreJoin(on: boolean): void {
  try {
    if (on) localStorage.setItem(SKIP_PREJOIN_KEY, '1');
    else localStorage.removeItem(SKIP_PREJOIN_KEY);
  } catch {
    /* storage unavailable: the choice lasts for this visit only */
  }
}

/** Opens the camera and microphone for the preview; each one separately, so a missing microphone does not hide the camera. */
async function openPreview(): Promise<{ stream: MediaStream | null; failed: boolean }> {
  if (!navigator.mediaDevices?.getUserMedia) return { stream: null, failed: true };
  try {
    return { stream: await navigator.mediaDevices.getUserMedia({ video: true, audio: true }), failed: false };
  } catch {
    /* try them one by one below */
  }
  const tracks: MediaStreamTrack[] = [];
  for (const c of [{ video: true }, { audio: true }] as const) {
    try {
      tracks.push(...(await navigator.mediaDevices.getUserMedia(c)).getTracks());
    } catch {
      /* this one is not available */
    }
  }
  return tracks.length ? { stream: new MediaStream(tracks), failed: false } : { stream: null, failed: true };
}

/**
 * Shown between "admitted" and the call itself, for members and guests alike: the person sees their own camera, chooses
 * whether the microphone and camera start on, and joins. The preview tracks are released before the call opens its own.
 */
export function PreJoin({ lang, title, onJoin, onCancel }: { lang: Lang; title: string; onJoin: (m: MediaChoice) => void; onCancel: () => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [mic, setMic] = useState(true);
  const [cam, setCam] = useState(true);
  const [hasMic, setHasMic] = useState(false);
  const [hasCam, setHasCam] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [skip, setSkip] = useState(readSkipPreJoin());

  useEffect(() => {
    let stopped = false;
    void openPreview().then(({ stream, failed }) => {
      if (stopped) {
        stream?.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      setHasMic((stream?.getAudioTracks().length ?? 0) > 0);
      setHasCam((stream?.getVideoTracks().length ?? 0) > 0);
      if (failed) {
        setProblem(mediaErrorText(lang));
        setMic(false);
        setCam(false);
      }
      if (videoRef.current && stream) videoRef.current.srcObject = stream;
    });
    return () => {
      stopped = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    streamRef.current?.getVideoTracks().forEach((t) => (t.enabled = cam));
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = mic));
  }, [cam, mic, hasCam, hasMic]);

  const join = () => {
    writeSkipPreJoin(skip);
    streamRef.current?.getTracks().forEach((t) => t.stop()); // release the devices before the call asks for them
    streamRef.current = null;
    onJoin({ mic: mic && hasMic, cam: cam && hasCam });
  };

  return (
    <main className="hm-center pj" data-testid="prejoin">
      <h1 className="pj__title">{tx(lang, 'hPreTitle')}</h1>
      <p className="pj__meeting">{title}</p>
      <div className="pj__preview">
        <video ref={videoRef} autoPlay muted playsInline className={cam && hasCam ? 'pj__video' : 'pj__video pj__video--off'} data-testid="prejoin-video" />
        {!(cam && hasCam) ? <p className="pj__off">{tx(lang, 'hPreCamOff')}</p> : null}
      </div>
      {problem ? <p className="pj__problem" role="alert">{problem}</p> : null}
      <div className="pj__toggles">
        <Switch label={tx(lang, 'hPreMic')} checked={mic && hasMic} disabled={!hasMic} data-testid="prejoin-mic" onChange={(e) => setMic(e.target.checked)} />
        <Switch label={tx(lang, 'hPreCam')} checked={cam && hasCam} disabled={!hasCam} data-testid="prejoin-cam" onChange={(e) => setCam(e.target.checked)} />
      </div>
      <Checkbox className="pj__skip" label={tx(lang, 'hPreSkip')} checked={skip} data-testid="prejoin-skip" onChange={(e) => setSkip(e.target.checked)} />
      <div className="pj__actions">
        <Button variant="primary" size="lg" fullWidth onClick={join} data-testid="prejoin-join">
          {tx(lang, 'hPreJoin')}
        </Button>
        <Button variant="ghost" size="md" fullWidth onClick={onCancel} data-testid="prejoin-cancel">
          {tx(lang, 'cancel')}
        </Button>
      </div>
    </main>
  );
}
