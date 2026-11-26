import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Track, type Participant } from 'livekit-client';
import { t, type Lang } from '../i18n';
import { Avatar, IconButton, IconCamera, IconCameraOff, IconMic, IconMicOff, IconPhoneOff, IconPip } from '../ui';

/**
 * Picture-in-picture. Chrome and Edge on desktop get a Document Picture-in-Picture window: a small always-on-top window with
 * the featured person and the essential controls (microphone, camera, back, leave). Other browsers that support video
 * picture-in-picture (Safari, Android Chrome) float the featured tile's video. Elsewhere the control is not shown.
 */

interface DocPip {
  requestWindow(opts: { width: number; height: number }): Promise<Window>;
  window: Window | null;
}
const docPip = (): DocPip | undefined => (typeof window !== 'undefined' ? (window as unknown as { documentPictureInPicture?: DocPip }).documentPictureInPicture : undefined);

export type PipKind = 'document' | 'video' | null;
export function pipKind(): PipKind {
  if (docPip()) return 'document';
  if (typeof document !== 'undefined' && document.pictureInPictureEnabled) return 'video';
  return null;
}

/**
 * Gives the window the same look: the html attributes (style, theme, language) and every stylesheet, adopted as constructed
 * sheets (CSSOM, so a strict style-src CSP is not involved); sheets that cannot be read are linked instead.
 */
function cloneStyles(from: Document, to: Document) {
  for (const a of Array.from(from.documentElement.attributes)) to.documentElement.setAttribute(a.name, a.value);
  // Refraction filters live in an SVG of the main document; the small window uses the CSS glass.
  to.documentElement.setAttribute('data-glass', 'css');
  const view = to.defaultView as (Window & typeof globalThis) | null;
  const adopted: CSSStyleSheet[] = [];
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const text = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n');
      if (view) {
        const s = new view.CSSStyleSheet();
        s.replaceSync(text);
        adopted.push(s);
      }
    } catch {
      if (sheet.href) {
        const l = to.createElement('link');
        l.rel = 'stylesheet';
        l.href = sheet.href;
        to.head.appendChild(l);
      }
    }
  }
  to.adoptedStyleSheets = adopted;
  to.body.className = 'dv-pip-body';
}

export async function openDocumentPip(): Promise<Window | null> {
  const api = docPip();
  if (!api) return null;
  const w = await api.requestWindow({ width: 380, height: 260 });
  cloneStyles(document, w.document);
  return w;
}

/** Floats the featured tile's video (or any video on the stage) with the browser's own picture-in-picture. */
export async function toggleVideoPip(): Promise<boolean> {
  if (document.pictureInPictureElement) {
    await document.exitPictureInPicture();
    return false;
  }
  const v = document.querySelector<HTMLVideoElement>('.grid .tile.featured video') ?? document.querySelector<HTMLVideoElement>('.grid .tile video');
  if (!v) return false;
  await v.requestPictureInPicture();
  return true;
}

/** Video only: the audio keeps playing from the main window (a second audio element would echo). */
function PipVideo({ p }: { p: Participant }) {
  const ref = useRef<HTMLVideoElement>(null);
  const share = p.getTrackPublication(Track.Source.ScreenShare);
  const cam = p.getTrackPublication(Track.Source.Camera);
  const pub = share?.track ? share : cam?.track && !cam.isMuted ? cam : undefined;
  const track = pub?.track;
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return undefined;
    track.attach(el);
    return () => void track.detach(el);
  }, [track]);
  if (!track) {
    return (
      <span className="dv-pip__avatar">
        <Avatar name={p.name || p.identity} id={p.identity} size={72} decorative />
      </span>
    );
  }
  return <video ref={ref} className={share?.track ? 'fit-contain' : undefined} autoPlay playsInline muted />;
}

export interface PipWindowProps {
  win: Window;
  lang: Lang;
  featured: Participant | null;
  name: string;
  mic: boolean;
  cam: boolean;
  onMic(): void;
  onCam(): void;
  onLeave(): void;
}

export function PipWindow({ win, lang, featured, name, mic, cam, onMic, onCam, onLeave }: PipWindowProps) {
  return createPortal(
    <div className="dv-pip" data-testid="pip-window">
      <div className="dv-pip__media">{featured ? <PipVideo p={featured} /> : <span className="dv-pip__empty">{t(lang, 'pipNoVideo')}</span>}</div>
      {featured ? <span className="dv-pip__name">{name}</span> : null}
      <div className="dv-pip__bar">
        <IconButton label={t(lang, 'mic')} icon={mic ? <IconMic size={18} /> : <IconMicOff size={18} />} variant={mic ? 'secondary' : 'danger'} tooltip={false} aria-pressed={!mic} onClick={onMic} data-testid="pip-mic" />
        <IconButton label={t(lang, 'camera')} icon={cam ? <IconCamera size={18} /> : <IconCameraOff size={18} />} variant={cam ? 'secondary' : 'danger'} tooltip={false} aria-pressed={!cam} onClick={onCam} data-testid="pip-cam" />
        <IconButton
          label={t(lang, 'pipBack')}
          icon={<IconPip size={18} />}
          variant="secondary"
          tooltip={false}
          onClick={() => {
            window.focus();
            win.close();
          }}
          data-testid="pip-back"
        />
        <IconButton label={t(lang, 'leave')} icon={<IconPhoneOff size={18} />} variant="danger" tooltip={false} onClick={onLeave} data-testid="pip-leave" />
      </div>
    </div>,
    win.document.body,
  );
}
