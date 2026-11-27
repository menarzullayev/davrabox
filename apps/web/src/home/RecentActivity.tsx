import { useEffect, useState } from 'react';
import type { ActivityItem } from '../api';
import type { Lang } from '../i18n';
import { Badge, IconClock, IconPaperclip, IconRecord, IconUsers, Skeleton } from '../ui';
import type { HomeApi } from './homeApi';
import { formatCode } from './logic';
import { tx } from './text';

/** "1 h 5 min", "42 min", "under a minute": whole minutes, as people read a meeting length. */
export function formatDuration(lang: Lang, seconds: number): string {
  if (seconds < 60) return tx(lang, 'raUnderMinute');
  const min = Math.round(seconds / 60);
  if (min < 60) return tx(lang, 'raMinutes', { n: min });
  return tx(lang, 'raHours', { h: Math.floor(min / 60), m: min % 60 });
}

function when(lang: Lang, iso: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * "Recent activity" (owner decision 7): the last ended meetings the person hosted or was in, with what the server really
 * recorded: duration, how many people, and files or recordings when there were any. Chat is never stored, so it is not shown.
 */
export function RecentActivity({ lang, api }: { lang: Lang; api: Pick<HomeApi, 'recentActivity'> }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.recentActivity().then(
      (r) => live && setItems(r.items),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [api]);

  return (
    <section className="hm-card hm-ra" aria-labelledby="hm-ra-h" data-testid="recent-activity" aria-busy={!items && !failed ? 'true' : undefined}>
      <h2 className="hm-card__title" id="hm-ra-h">
        {tx(lang, 'raTitle')}
      </h2>
      {failed ? (
        <p className="pg-empty">{tx(lang, 'raLoadFailed')}</p>
      ) : !items ? (
        <div className="hm-skeletons">
          <Skeleton height="3rem" />
          <Skeleton height="3rem" />
        </div>
      ) : items.length === 0 ? (
        <p className="pg-empty" data-testid="ra-empty">
          {tx(lang, 'raEmpty')}
        </p>
      ) : (
        <ul className="pg-list hm-ra__list">
          {items.map((it) => (
            <li key={it.id} className="pg-item" data-testid="ra-item">
              <div className="pg-item__main">
                <p className="pg-item__title">{it.title}</p>
                <p className="pg-item__meta">
                  <span>{when(lang, it.endedAt)}</span>
                  <span className="hm-row__chip" data-testid="ra-duration">
                    <IconClock size={14} />
                    {formatDuration(lang, it.durationSeconds)}
                  </span>
                  <span className="hm-row__chip" data-testid="ra-people">
                    <IconUsers size={14} />
                    {tx(lang, 'raPeople', { n: it.participants })}
                    {it.guests ? `, ${tx(lang, 'raGuests', { n: it.guests })}` : ''}
                  </span>
                  {it.files ? (
                    <span className="hm-row__chip" data-testid="ra-files">
                      <IconPaperclip size={14} />
                      {tx(lang, 'raFiles', { n: it.files })}
                    </span>
                  ) : null}
                  {it.recordings ? (
                    <span className="hm-row__chip" data-testid="ra-recordings">
                      <IconRecord size={14} />
                      {tx(lang, 'raRecordings', { n: it.recordings })}
                    </span>
                  ) : null}
                  <span className="code">{formatCode(it.meetingCode)}</span>
                </p>
              </div>
              <div className="pg-item__actions">
                {it.personal ? <Badge tone="accent">{tx(lang, 'raPersonal')}</Badge> : null}
                {it.isHost ? <Badge>{tx(lang, 'raHost')}</Badge> : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
