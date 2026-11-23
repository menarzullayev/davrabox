import { useEffect, useRef } from 'react';
import { Track, type Participant, type RemoteTrack } from 'livekit-client';

/**
 * The only place where a LiveKit track meets a DOM element. It renders the `<video>` of a participant's camera or
 * screen (when there is something to show) and, for remote participants, the `<audio>` that plays their microphone.
 * The presentational tile decides everything else (avatar fallback, labels, layout).
 */
export function LiveMedia({ p, kind, local }: { p: Participant; kind: 'camera' | 'share'; local: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const pub = p.getTrackPublication(kind === 'camera' ? Track.Source.Camera : Track.Source.ScreenShare);
  const track = pub?.track;
  const showVideo = !!track && (kind === 'share' || !pub?.isMuted);

  useEffect(() => {
    const el = videoRef.current;
    if (el && track && showVideo) {
      track.attach(el);
      return () => void track.detach(el);
    }
    return undefined;
  }, [track, showVideo]);

  // Remote audio must be attached to an element to play.
  const audioTrack = kind === 'camera' && !local ? (p.getTrackPublication(Track.Source.Microphone)?.track as RemoteTrack | undefined) : undefined;
  useEffect(() => {
    const el = audioRef.current;
    if (el && audioTrack) {
      audioTrack.attach(el);
      return () => void audioTrack.detach(el);
    }
    return undefined;
  }, [audioTrack]);

  return (
    <>
      {showVideo ? <video ref={videoRef} className={kind === 'share' ? 'fit-contain' : undefined} autoPlay playsInline muted={local} /> : null}
      {kind === 'camera' && !local ? <audio ref={audioRef} autoPlay /> : null}
    </>
  );
}
