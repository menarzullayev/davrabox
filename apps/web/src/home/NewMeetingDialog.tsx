import { useEffect, useState, type FormEvent } from 'react';
import { Alert, Button, Checkbox, DateTimePicker, Dialog, Switch, TextField, parseDateTime } from '../ui';
import { t, type Lang } from '../i18n';
import type { GuestMode, Meeting } from '../api';
import { tx } from './text';
import { GuestModeSelect, defaultGuestMode } from './GuestModeSelect';

export interface NewMeetingData {
  title: string;
  passcode?: string;
  waitingRoom: boolean;
  /** End-to-end encrypted meeting; chosen here and never changed afterwards. */
  e2ee: boolean;
  /** Guests (people without an account); absent = off. */
  guests?: GuestMode;
  /** ISO start time of a scheduled meeting (the Schedule quick action); absent = start now. */
  scheduledAt?: string;
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
  /** The Schedule quick action (owner decision 2): the same form with the date and time first and required. */
  schedule?: boolean;
}

const FORM_ID = 'hm-new-form';

/** The next round half hour from now, as the picker's local `YYYY-MM-DDTHH:mm` text. */
export function nextSlot(now: Date): string {
  const d = new Date(now.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The picker's local text as an ISO instant; null when it is not a valid date or not in the future. */
export function scheduledIso(value: string, now: Date): string | null {
  const p = parseDateTime(value);
  if (!p) return null;
  const at = new Date(p.y, p.m - 1, p.d, p.h, p.min);
  return at.getTime() > now.getTime() ? at.toISOString() : null;
}

export function NewMeetingDialog({ lang, open, onClose, onCreate, onCreated, calendar, guestMax = 'off', schedule = false }: NewMeetingDialogProps) {
  const [title, setTitle] = useState('');
  const [passcode, setPasscode] = useState('');
  const [waitingRoom, setWaitingRoom] = useState(true);
  const [e2ee, setE2ee] = useState(false);
  const [guests, setGuests] = useState<GuestMode>('off');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [addCalendar, setAddCalendar] = useState(false);
  const [when, setWhen] = useState('');
  const [whenBad, setWhenBad] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFailed(false);
    setGuests(defaultGuestMode(guestMax)); // the waiting room when the organization allows guests
    setWhen(schedule ? nextSlot(new Date()) : '');
    setWhenBad(false);
    // showModal() focuses the close button first: put the caret in the title field once the dialog is shown.
    const raf = requestAnimationFrame(() => document.getElementById('hm-new-title')?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, guestMax, schedule]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const at = schedule ? scheduledIso(when, new Date()) : null;
    if (schedule && !at) {
      setWhenBad(true);
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      const m = await onCreate({
        title: title.trim(),
        passcode: passcode || undefined,
        waitingRoom,
        e2ee,
        ...(guestMax !== 'off' ? { guests: guests === 'open' && guestMax !== 'open' ? guestMax : guests } : {}),
        ...(at ? { scheduledAt: at } : {}),
      });
      setTitle('');
      setPasscode('');
      setWaitingRoom(true);
      setE2ee(false);
      setGuests(defaultGuestMode(guestMax));
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
      title={tx(lang, schedule ? 'schedTitle' : 'hNewTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t(lang, 'cancel')}
          </Button>
          <Button variant="primary" type="submit" form={FORM_ID} loading={busy} data-testid="new-meeting-submit">
            {schedule ? tx(lang, 'schedCreate') : t(lang, 'create')}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} className="hm-new__form" onSubmit={(e) => void submit(e)}>
        <p className="hm-new__lead">{tx(lang, 'hNewLead')}</p>
        {failed ? <Alert tone="danger">{t(lang, 'errGeneric')}</Alert> : null}
        {schedule ? (
          <DateTimePicker
            lang={lang}
            label={tx(lang, 'schedWhen')}
            hint={tx(lang, 'schedWhenHint')}
            error={whenBad ? tx(lang, 'schedPast') : undefined}
            required
            value={when}
            data-testid="schedule-when"
            onChange={(e) => {
              setWhen(e.target.value);
              setWhenBad(false);
            }}
          />
        ) : null}
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
        {guestMax !== 'off' ? <GuestModeSelect lang={lang} value={guests} max={guestMax} onChange={setGuests} /> : null}
        {calendar ? <Checkbox label={tx(lang, 'calAfterCreate')} checked={addCalendar} data-testid="cal-after-create" onChange={(e) => setAddCalendar(e.target.checked)} /> : null}
      </form>
    </Dialog>
  );
}
