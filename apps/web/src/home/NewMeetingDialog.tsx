import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Checkbox, Dialog, Select, Switch, TextField } from '../ui';
import { t, type Lang } from '../i18n';
import type { GuestMode, Meeting } from '../api';
import { tx } from './text';

export interface NewMeetingData {
  title: string;
  passcode?: string;
  waitingRoom: boolean;
  /** End-to-end encrypted meeting; chosen here and never changed afterwards. */
  e2ee: boolean;
  /** Guests (people without an account); absent = off. */
  guests?: GuestMode;
}

export interface NewMeetingDialogProps {
  lang: Lang;
  open: boolean;
  onClose: () => void;
  /** Resolves with the created meeting; a rejection shows the generic error inside the dialog. */
  onCreate: (data: NewMeetingData) => Promise<Meeting>;
  onCreated: (m: Meeting, opts?: { calendar?: boolean }) => void;
  /** Offer "add to calendar after creating" (calendar integration). */
  calendar?: boolean;
  /** The most the organization allows for guests; the choice is shown only when it is above 'off'. */
  guestMax?: GuestMode;
}

const FORM_ID = 'hm-new-form';

export function NewMeetingDialog({ lang, open, onClose, onCreate, onCreated, calendar, guestMax = 'off' }: NewMeetingDialogProps) {
  const [title, setTitle] = useState('');
  const [passcode, setPasscode] = useState('');
  const [waitingRoom, setWaitingRoom] = useState(true);
  const [e2ee, setE2ee] = useState(false);
  const [guests, setGuests] = useState<GuestMode>('off');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [addCalendar, setAddCalendar] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFailed(false);
    // showModal() focuses the close button first: put the caret in the title field once the dialog is shown.
    const raf = requestAnimationFrame(() => document.getElementById('hm-new-title')?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const m = await onCreate({ title: title.trim(), passcode: passcode || undefined, waitingRoom, e2ee, ...(guestMax !== 'off' ? { guests: guests === 'open' && guestMax !== 'open' ? guestMax : guests } : {}) });
      setTitle('');
      setPasscode('');
      setWaitingRoom(true);
      setE2ee(false);
      setGuests('off');
      onCreated(m, calendar && addCalendar ? { calendar: true } : undefined);
      setAddCalendar(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      closeLabel={t(lang, 'uiClose')}
      title={tx(lang, 'hNewTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t(lang, 'cancel')}
          </Button>
          <Button variant="primary" type="submit" form={FORM_ID} loading={busy}>
            {t(lang, 'create')}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className="hm-new__form" onSubmit={(e) => void submit(e)}>
        <p className="hm-new__lead">{tx(lang, 'hNewLead')}</p>
        {failed ? <Alert tone="danger">{t(lang, 'errGeneric')}</Alert> : null}
        <TextField
          label={t(lang, 'title')}
          id="hm-new-title"
          required
          maxLength={200}
          data-testid="meeting-title"
          placeholder={tx(lang, 'hNewTitlePlaceholder')}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <TextField
          label={t(lang, 'passcode')}
          type="password"
          minLength={6}
          maxLength={64}
          autoComplete="new-password"
          hint={tx(lang, 'hNewPasscodeHint')}
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
        />
        <Switch
          label={t(lang, 'waitingRoom')}
          hint={tx(lang, 'hNewWaitingHint')}
          checked={waitingRoom}
          data-testid="waiting-room"
          onChange={(e) => setWaitingRoom(e.target.checked)}
        />
        <Switch label={t(lang, 'e2eeToggle')} hint={t(lang, 'e2eeToggleHint')} checked={e2ee} data-testid="e2ee-toggle" onChange={(e) => setE2ee(e.target.checked)} />
        {guestMax !== 'off' ? (
          <Select label={tx(lang, 'hNewGuests')} hint={tx(lang, 'hNewGuestsHint')} data-testid="guest-mode" value={guests} onChange={(e) => setGuests(e.target.value as GuestMode)}>
            <option value="off">{tx(lang, 'hNewGuestsOff')}</option>
            <option value="waiting_room">{tx(lang, 'hNewGuestsWait')}</option>
            {guestMax === 'open' ? <option value="open">{tx(lang, 'hNewGuestsOpen')}</option> : null}
          </Select>
        ) : null}
        {calendar ? <Checkbox label={tx(lang, 'calAfterCreate')} checked={addCalendar} data-testid="cal-after-create" onChange={(e) => setAddCalendar(e.target.checked)} /> : null}
      </form>
    </Dialog>
  );
}
