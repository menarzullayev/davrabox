import { useEffect, useRef, useState } from 'react';
import { t, type Lang } from '../i18n';
import { Button, IconDownload, type IconProps } from '../ui';
import './recording.css';
import type { RecordingItem } from './types';

/** A filled dot: the "record" mark. Decorative; the words next to it carry the meaning. */
export function IconRecord({ size = 20 }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="6.5" fill="currentColor" />
    </svg>
  );
}

/** The consent badge every participant sees while a recording runs. Colour is never the only cue: it says so in words. */
export function RecordingBadge({ lang, on }: { lang: Lang; on: boolean }) {
  if (!on) return null;
  return (
    <span className="dv-pill dv-rec" data-testid="rec-badge">
      <span className="dv-rec__dot" aria-hidden="true" />
      <span className="dv-rec__text">{t(lang, 'clRecBadge')}</span>
      <span className="dx-sr-only">: {t(lang, 'clRecBadgeHint')}</span>
    </span>
  );
}

/**
 * Polite live region for the recording state, always mounted so the change is announced. It announces when recording is on at
 * mount (somebody joining late) and when it starts or stops; it stays silent for a meeting that never recorded.
 */
export function RecordingLive({ lang, on }: { lang: Lang; on: boolean }) {
  const [text, setText] = useState('');
  const everOn = useRef(false);
  useEffect(() => {
    if (!on && !everOn.current) return undefined;
    if (on) everOn.current = true;
    // Clear first so the same sentence is read again if recording is started a second time.
    setText('');
    const raf = requestAnimationFrame(() => setText(t(lang, on ? 'clAnnRecOn' : 'clAnnRecOff')));
    return () => cancelAnimationFrame(raf);
  }, [on, lang]);
  return (
    <div className="dx-sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="rec-live">
      {text}
    </div>
  );
}

const STATUS_KEY = { ready: 'clRecSReady', failed: 'clRecSFailed', active: 'clRecSActive', starting: 'clRecSActive', stopping: 'clRecSProcessing', processing: 'clRecSProcessing' } as const;

/** DD.MM.YYYY HH:MM in local time: the same in every language (uz month names are not available in every browser's ICU data). */
function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sizeText(n: number | null): string {
  if (n === null) return '';
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** The manager's list of recordings of this meeting; a download is offered only for a finished (encrypted, ready) one. */
export function RecordingList({ lang, items, onDownload }: { lang: Lang; items: RecordingItem[]; onDownload?(id: string): void }) {
  return (
    <section className="dv-recs" aria-label={t(lang, 'clRecListTitle')}>
      <h3 className="dv-recs__title">{t(lang, 'clRecListTitle')}</h3>
      {items.length === 0 ? (
        <p className="dv-pop__note">{t(lang, 'clRecListEmpty')}</p>
      ) : (
        <ul className="dv-recs__list">
          {items.map((r) => {
            const when = new Date(r.startedAt);
            const label = Number.isNaN(when.getTime()) ? '' : stamp(when);
            const status = t(lang, STATUS_KEY[r.status as keyof typeof STATUS_KEY] ?? 'clRecSFailed');
            return (
              <li key={r.id} className="dv-recs__item" data-testid="rec-item">
                <span className="dv-recs__what">
                  <span>{label}</span>
                  <span className="dv-recs__meta">{[status, sizeText(r.sizeBytes)].filter(Boolean).join(', ')}</span>
                </span>
                {r.status === 'ready' && onDownload ? (
                  <Button size="sm" variant="secondary" icon={<IconDownload size={16} />} data-testid="rec-download" onClick={() => onDownload(r.id)}>
                    {t(lang, 'clRecDownload')}
                    <span className="dx-sr-only">: {label}</span>
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
