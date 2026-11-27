import { useEffect, useState } from 'react';
import type { MyRecording } from '../api';
import type { Lang } from '../i18n';
import { Alert, Button, IconDownload, Skeleton, useToast } from '../ui';
import type { HomeApi } from '../home/homeApi';
import { formatCode } from '../home/logic';
import { tx } from '../home/text';
import { fileBase, saveBlob } from '../call/download';

function when(lang: Lang, iso: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * "Recordings" (owner decision 1): finished recordings of the meetings the person manages. While recording is switched off
 * on the server the page says so plainly (no empty list that looks broken, nothing invented).
 */
export function RecordingsPage({ lang, api }: { lang: Lang; api: Pick<HomeApi, 'myRecordings' | 'downloadRecording'> }) {
  const toast = useToast();
  const [data, setData] = useState<{ enabled: boolean; items: MyRecording[] } | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.myRecordings().then(
      (r) => live && setData(r),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const download = async (r: MyRecording) => {
    setBusy(r.id);
    try {
      saveBlob(await api.downloadRecording(r.id), `${fileBase(r.title, 'recording')}-${r.startedAt.slice(0, 10)}.mp4`);
    } catch {
      toast({ tone: 'danger', title: tx(lang, 'rcLoadFailed') });
    } finally {
      setBusy(null);
    }
  };

  return (
    <main id="hm-main" className="home hm-main" tabIndex={-1} data-testid="recordings-page">
      <header className="pg-head">
        <h1 className="pg-title">{tx(lang, 'rcTitle')}</h1>
        <p className="pg-lead">{tx(lang, 'rcLead')}</p>
      </header>
      {failed ? (
        <Alert tone="danger">{tx(lang, 'rcLoadFailed')}</Alert>
      ) : !data ? (
        <div className="hm-skeletons" aria-busy="true">
          <Skeleton height="3.5rem" />
          <Skeleton height="3.5rem" />
        </div>
      ) : (
        <div className="pg-stack">
          {!data.enabled ? (
            <div data-testid="rc-off">
              <Alert tone="info">{tx(lang, 'rcOff')}</Alert>
            </div>
          ) : null}
          {data.items.length === 0 ? (
            data.enabled ? (
              <p className="pg-empty" data-testid="rc-empty">
                {tx(lang, 'rcEmpty')}
              </p>
            ) : null
          ) : (
            <ul className="pg-list">
              {data.items.map((r) => (
                <li key={r.id} className="pg-item" data-testid="rc-item">
                  <div className="pg-item__main">
                    <p className="pg-item__title">{r.title}</p>
                    <p className="pg-item__meta">
                      <span>{when(lang, r.startedAt)}</span>
                      {r.sizeBytes ? <span>{tx(lang, 'rcSize', { n: Math.max(1, Math.round(r.sizeBytes / 1_048_576)) })}</span> : null}
                      <span className="code">{formatCode(r.meetingCode)}</span>
                    </p>
                  </div>
                  <div className="pg-item__actions">
                    <Button variant="secondary" size="sm" icon={<IconDownload size={16} />} loading={busy === r.id} disabled={!data.enabled} data-testid="rc-download" onClick={() => void download(r)}>
                      {tx(lang, 'rcDownload')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </main>
  );
}
