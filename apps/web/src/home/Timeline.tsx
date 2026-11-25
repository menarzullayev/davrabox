import { useEffect, useRef, useState } from 'react';
import { Badge, Button, EmptyState, IconButton, IconCalendar, IconCheck, IconLink, IconLock, IconPlus, IconShield, Skeleton } from '../ui';
import type { Key, Lang } from '../i18n';
import { GROUP_ORDER, createdLabel, formatClock, formatCode, joinLink, timelineSize, type Timeline, type TimelineGroup, type TimelineMeeting } from './logic';
import { dayNames, tx } from './text';
import { buildShareLink, loadStoredKey } from '../e2ee/keys';

const GROUP_KEY: Record<TimelineGroup, Key> = {
  now: 'hGroupNow',
  later: 'hGroupLater',
  upcoming: 'hGroupUpcoming',
  recent: 'hGroupRecent',
  earlier: 'hGroupEarlier',
};

/** A group longer than this is folded behind a "show all" button (the list used to grow without bound). */
export const GROUP_CAP = 6;

export interface MeetingRowProps {
  lang: Lang;
  m: TimelineMeeting;
  group: TimelineGroup;
  /** The clock the "created" label is measured against. */
  now: Date;
  busy: boolean;
  onJoin: (m: TimelineMeeting) => void;
  onCopy: (m: TimelineMeeting) => Promise<boolean>;
  /** Offered to the host of the meeting when set (calendar integration). */
  onCalendar?: (m: TimelineMeeting) => void;
}

function MeetingRow({ lang, m, group, now, busy, onJoin, onCopy, onCalendar }: MeetingRowProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    if (!(await onCopy(m))) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1800);
  };

  const created = m.start ? null : createdLabel(m.created, now, dayNames(lang).months);
  return (
    <li className="hm-row" data-group={group}>
      <div className="hm-row__time dx-tabular">{m.start ? formatClock(m.start) : <span className="hm-row__notime">{tx(lang, 'hNoTime')}</span>}</div>
      <div className="hm-row__rail" aria-hidden="true">
        <span className="hm-row__dot" />
      </div>
      <div className="hm-row__card">
        <div className="hm-row__main">
          <p className="hm-row__title" title={m.title}>
            {m.title}
          </p>
          <div className="hm-row__meta">
            <span className="code dx-tabular">{formatCode(m.code)}</span>
            {m.has_passcode ? (
              <span className="hm-row__chip">
                <IconShield size={14} />
                {tx(lang, 'hHasPasscode')}
              </span>
            ) : null}
            {m.locked ? (
              <Badge tone="warning">
                <IconLock size={12} />
                {tx(lang, 'hLocked')}
              </Badge>
            ) : null}
            {m.e2ee ? (
              <Badge tone="success">
                <IconLock size={12} />
                {tx(lang, 'e2eeRowBadge')}
              </Badge>
            ) : null}
            {created ? (
              <span className="hm-row__created" data-testid="row-created">
                {tx(lang, created.key, 'vars' in created ? created.vars : undefined)}
              </span>
            ) : null}
            {m.is_host ? <Badge tone="gold">{tx(lang, 'hHostYou')}</Badge> : null}
            {group === 'now' ? (
              <Badge tone="success" dot>
                {tx(lang, 'hNowBadge')}
              </Badge>
            ) : null}
          </div>
        </div>
        <div className="hm-row__actions">
          {onCalendar && m.is_host ? (
            <IconButton label={tx(lang, 'calActionAria', { title: m.title })} icon={<IconCalendar />} data-testid="cal-row" onClick={() => onCalendar(m)} />
          ) : null}
          <IconButton label={tx(lang, copied ? 'hLinkCopied' : 'hCopyLink')} icon={copied ? <IconCheck /> : <IconLink />} onClick={() => void copy()} />
          <Button variant={group === 'now' ? 'primary' : 'secondary'} size="sm" loading={busy} aria-label={tx(lang, 'hJoinRowAria', { title: m.title })} onClick={() => onJoin(m)}>
            {tx(lang, 'join')}
          </Button>
        </div>
      </div>
    </li>
  );
}

export interface TimelineViewProps {
  lang: Lang;
  /** null while the first load is running. */
  timeline: Timeline | null;
  now: Date;
  joiningCode: string | null;
  onJoin: (m: TimelineMeeting) => void;
  onCopy: (m: TimelineMeeting) => Promise<boolean>;
  onNew: () => void;
  onCalendar?: (m: TimelineMeeting) => void;
}

/** Meetings as a day timeline: a rail with a dot per meeting, grouped now / later today / upcoming / recent / earlier. */
export function TimelineView({ lang, timeline, now, joiningCode, onJoin, onCopy, onNew, onCalendar }: TimelineViewProps) {
  const [open, setOpen] = useState<Partial<Record<TimelineGroup, boolean>>>({});
  if (!timeline) {
    return (
      <div className="hm-skeletons" aria-busy="true" aria-label={tx(lang, 'hListLoading')} role="status">
        {[0, 1, 2].map((i) => (
          <div className="hm-skeleton-row" key={i}>
            <Skeleton width={44} height={16} />
            <Skeleton height={64} radius={14} />
          </div>
        ))}
      </div>
    );
  }
  if (timelineSize(timeline) === 0) {
    return (
      <div className="hm-empty">
        <EmptyState
          as="h3"
          title={tx(lang, 'hEmptyTitle')}
          description={tx(lang, 'hEmptyText')}
          action={
            <Button variant="highlight" size="lg" icon={<IconPlus />} data-testid="new-meeting-empty" onClick={onNew}>
              {tx(lang, 'hNewAction')}
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <div className="hm-days">
      {GROUP_ORDER.filter((g) => timeline[g].length > 0).map((g) => (
        <section className="hm-group" data-group={g} key={g} aria-labelledby={`hm-g-${g}`}>
          <h3 className="hm-group__title" id={`hm-g-${g}`}>
            {tx(lang, GROUP_KEY[g])}
            <span className="hm-group__count dx-tabular">{timeline[g].length}</span>
          </h3>
          <ul className="hm-list">
            {(open[g] || timeline[g].length <= GROUP_CAP ? timeline[g] : timeline[g].slice(0, GROUP_CAP)).map((m) => (
              <MeetingRow key={m.id} lang={lang} m={m} group={g} now={now} busy={joiningCode === m.code} onJoin={onJoin} onCopy={onCopy} onCalendar={onCalendar} />
            ))}
          </ul>
          {timeline[g].length > GROUP_CAP ? (
            <Button variant="ghost" size="sm" data-testid={`group-more-${g}`} aria-expanded={!!open[g]} onClick={() => setOpen((o) => ({ ...o, [g]: !o[g] }))}>
              {open[g] ? tx(lang, 'hShowLess') : tx(lang, 'hShowAll', { n: timeline[g].length })}
            </Button>
          ) : null}
        </section>
      ))}
    </div>
  );
}

/** Copies the join link; true on success. Falls back to a temporary textarea where the async clipboard is unavailable. */
export async function copyJoinLink(origin: string, code: string): Promise<boolean> {
  // An encrypted meeting's link carries its key after the #, when this tab holds it (the creator's or a joiner's tab).
  const key = loadStoredKey(code);
  const link = key ? buildShareLink(origin, code, key) : joinLink(origin, code);
  try {
    await navigator.clipboard.writeText(link);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = link;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
