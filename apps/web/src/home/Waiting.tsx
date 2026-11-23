import { useEffect, useRef } from 'react';
import { api, ApiError, type JoinedResult } from '../api';
import { freshToken } from '../auth';
import type { Lang } from '../i18n';
import { WaitingView } from './AuthScreens';

/** Polls the join request every 2 s until the host admits, denies or removes it (unchanged behaviour). */
export function Waiting({ lang, code, requestId, onAdmitted, onFailed, onCancel }: {
  lang: Lang;
  code: string;
  requestId: string;
  onAdmitted: (j: JoinedResult) => void;
  onFailed: (e: unknown) => void;
  onCancel: () => void;
}) {
  const done = useRef(false);
  useEffect(() => {
    done.current = false;
    const tick = async () => {
      if (done.current) return;
      try {
        const r = await api.requestStatus(await freshToken(), code, requestId);
        if (r.status === 'joined' && !done.current) {
          done.current = true;
          onAdmitted(r);
        }
      } catch (e) {
        if (e instanceof ApiError && !done.current) {
          done.current = true;
          onFailed(e);
        }
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      done.current = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, requestId]);
  return <WaitingView lang={lang} code={code} onCancel={onCancel} />;
}
