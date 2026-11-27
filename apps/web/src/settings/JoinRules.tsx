import { useEffect } from 'react';
import { t, type Lang } from '../i18n';
import { Button, ConnectingRing, Dialog } from '../ui';

/** The organization's notice before joining (decision 2): the join goes on only after "I accept" (the server checks it). */
export function JoinNotice({ lang, text, onAccept, onCancel }: { lang: Lang; text: string | null; onAccept: () => void; onCancel: () => void }) {
  return (
    <Dialog
      open={text !== null}
      onClose={onCancel}
      closeLabel={t(lang, 'cancel')}
      title={t(lang, 'jnDisclaimerTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t(lang, 'cancel')}
          </Button>
          <Button variant="primary" onClick={onAccept} data-testid="join-notice-accept">
            {t(lang, 'jnAccept')}
          </Button>
        </>
      }
    >
      <p className="jn-text" data-testid="join-notice-text">
        {text}
      </p>
    </Dialog>
  );
}

/** "Join before host" is off and nobody of the host side is there yet: wait and try again every few seconds. */
export function HostWait({ lang, onRetry, onCancel, everyMs = 5000 }: { lang: Lang; onRetry: () => void; onCancel: () => void; everyMs?: number }) {
  useEffect(() => {
    const id = setInterval(onRetry, everyMs);
    return () => clearInterval(id);
  }, [onRetry, everyMs]);
  return (
    <main className="hm-center hm-wait" data-testid="host-wait">
      <ConnectingRing label={t(lang, 'jnHostAbsentTitle')} />
      <h1 className="hm-wait__title">{t(lang, 'jnHostAbsentTitle')}</h1>
      <p className="hm-wait__text">{t(lang, 'jnHostAbsent')}</p>
      <Button variant="ghost" onClick={onCancel} data-testid="host-wait-cancel">
        {t(lang, 'cancel')}
      </Button>
    </main>
  );
}
