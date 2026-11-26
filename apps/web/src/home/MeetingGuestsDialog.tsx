import { useEffect, useState } from 'react';
import type { GuestMode, Meeting } from '../api';
import { t, type Lang } from '../i18n';
import { Button, Dialog } from '../ui';
import { GuestModeSelect } from './GuestModeSelect';
import { tx } from './text';

/** Changes who may join an existing meeting without an account (host side), within the organization's limit. */
export function MeetingGuestsDialog({ lang, meeting, max, onSave, onClose }: { lang: Lang; meeting: Meeting | null; max: GuestMode; onSave: (code: string, m: GuestMode) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState<GuestMode>('off');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!meeting) return;
    setValue(meeting.guest_mode ?? 'off');
    setFailed(false);
  }, [meeting]);
  const save = async () => {
    if (!meeting) return;
    setBusy(true);
    setFailed(false);
    try {
      await onSave(meeting.code, value);
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={meeting !== null}
      onClose={onClose}
      title={tx(lang, 'hEditGuestsTitle')}
      closeLabel={t(lang, 'uiClose')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t(lang, 'cancel')}
          </Button>
          <Button loading={busy} data-testid="guests-save" disabled={!meeting || value === (meeting.guest_mode ?? 'off')} onClick={() => void save()}>
            {tx(lang, 'hEditGuestsSave')}
          </Button>
        </>
      }
    >
      {meeting ? <p className="hm-card__lead">{meeting.title}</p> : null}
      <GuestModeSelect lang={lang} value={value} max={max} onChange={setValue} testId="guests-edit" />
      {failed ? (
        <p className="dx-field__error" role="alert">
          {tx(lang, 'hEditGuestsFailed')}
        </p>
      ) : null}
    </Dialog>
  );
}
