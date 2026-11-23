import { t, type Lang } from '../i18n';
import { Badge, Button, IconLock, IconShieldCheck, IconUnlock, IconUsers, LogoMark } from '../ui';
import type { Quality, Role } from './types';

const QUALITY_KEY = { excellent: 'clQExcellent', good: 'clQGood', poor: 'clQPoor', lost: 'clQLost', unknown: 'clQUnknown' } as const;
const BARS: Record<Quality, number> = { excellent: 3, good: 2, poor: 1, lost: 0, unknown: 0 };

/** Three signal bars; the level is also written in words (never colour alone). */
export function QualityMeter({ lang, quality, compactText }: { lang: Lang; quality: Quality; compactText?: boolean }) {
  const n = BARS[quality];
  const label = t(lang, QUALITY_KEY[quality]);
  return (
    <span className="dv-pill dv-quality" data-q={quality} data-testid="quality">
      <svg width="18" height="16" viewBox="0 0 18 16" aria-hidden="true" focusable="false">
        {[0, 1, 2].map((i) => (
          <rect key={i} x={i * 6 + 0.5} y={15 - (4 + i * 4.5)} width="4.5" height={4 + i * 4.5} rx="1.2" className={i < n ? 'on' : 'off'} />
        ))}
      </svg>
      <span className={compactText ? 'dv-pill__text' : 'dx-sr-only'} aria-hidden="true">{label}</span>
      <span className="dx-sr-only">{`${t(lang, 'clQuality')}: ${label}`}</span>
    </span>
  );
}

export interface TopBarProps {
  lang: Lang;
  title: string;
  count: number;
  role: Role;
  /** Managers can lock the meeting; members get no lock control. */
  locked: boolean;
  onLock?: () => void;
  quality: Quality;
}

export function TopBar({ lang, title, count, role, locked, onLock, quality }: TopBarProps) {
  const manages = role !== 'member';
  return (
    <header className="callbar dv-topbar">
      <span className="dv-mark">
        <LogoMark size={26} />
      </span>
      <h1 className="dv-title" title={title}>{title}</h1>
      <div className="dv-top-right">
        {manages ? (
          <Badge tone="gold" className="badge dv-role" data-testid="role-badge">
            {role === 'cohost' ? t(lang, 'cohostBadge') : t(lang, 'hostBadge')}
          </Badge>
        ) : null}
        {manages && onLock ? (
          <Button
            className="dv-lock"
            size="sm"
            variant={locked ? 'highlight' : 'secondary'}
            icon={locked ? <IconLock size={16} /> : <IconUnlock size={16} />}
            aria-pressed={locked}
            data-testid="lock"
            onClick={onLock}
          >
            <span className="dv-lock__text">{t(lang, 'lockMeeting')}</span>
          </Button>
        ) : null}
        <span className="dv-pill dv-secure">
          <IconShieldCheck size={16} />
          <span className="dv-pill__text">{t(lang, 'clSecure')}</span>
          <span className="dx-sr-only">: {t(lang, 'clSecureHint')}</span>
        </span>
        <QualityMeter lang={lang} quality={quality} />
        <span className="dv-pill dv-count" role="group" aria-label={`${t(lang, 'clParticipants')}: ${count}`}>
          <IconUsers size={16} />
          <span className="count dx-tabular" data-testid="count" aria-hidden="true">{count}</span>
        </span>
      </div>
    </header>
  );
}
