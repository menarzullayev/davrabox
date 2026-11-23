import { useCallback, useEffect, useState } from 'react';
import { t } from '../i18n';
import type { Overview as OverviewData } from './client';
import { ErrorBox, useAdmin } from './ui';

export function Overview() {
  const { client, lang, report } = useAdmin();
  const [data, setData] = useState<OverviewData | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      setData(await client.overview());
    } catch (e) {
      setErr(t(lang, report(e)));
    }
  }, [client, lang, report]);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  return (
    <section aria-labelledby="sec-overview">
      <h2 id="sec-overview" className="sec-title">{t(lang, 'admOverview')}</h2>
      <ErrorBox text={err} />
      {err && <button onClick={() => void load()}>{t(lang, 'admRetry')}</button>}
      {!data && !err && <p className="muted" role="status">{t(lang, 'admLoading')}</p>}
      {data && (
        <dl className="stats">
          <div className="stat"><dt>{t(lang, 'admOrg')}</dt><dd>{data.org.name}</dd></div>
          <div className="stat"><dt>{t(lang, 'admSlug')}</dt><dd className="code">{data.org.slug}</dd></div>
          <div className="stat"><dt>{t(lang, 'admUserCount')}</dt><dd>{data.users}</dd></div>
          <div className="stat">
            <dt>{t(lang, 'admSeats')}</dt>
            <dd>{data.seatsLimit === null ? `${data.users} · ${t(lang, 'admUnlimited')}` : `${data.users} / ${data.seatsLimit}`}</dd>
          </div>
          <div className="stat"><dt>{t(lang, 'admMeetings30')}</dt><dd>{data.meetingsLast30d}</dd></div>
        </dl>
      )}
    </section>
  );
}
