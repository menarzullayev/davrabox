import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, type Meeting } from '../api';
import { t, type Key, type Lang } from '../i18n';
import { Alert, Badge, Button, DateTimePicker, Dialog, Select, Spinner, TextField } from '../ui';
import { tx } from '../home/text';
import { calendarApi, type CalendarApi, type ProviderStatus } from './calendarApi';
import { buildEventBody, calendarErrorKey, defaultStart, toLocalInput, type CalProvider } from './logic';
import './calendar.css';

export interface AddToCalendarDialogProps {
  lang: Lang;
  token: string;
  /** The meeting to add; the dialog is open while this is set. */
  meeting: Meeting | null;
  onClose: () => void;
  api?: CalendarApi;
  /** Navigates the browser to the provider's consent page (replaceable in tests). */
  navigate?: (url: string) => void;
  now?: Date;
}

const PROVIDER_LABEL: Record<CalProvider, Key> = { google: 'calGoogle', microsoft: 'calOutlook' };
const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const FORM_ID = 'cal-form';

function durationLabel(lang: Lang, m: number): string {
  return m % 60 === 0 && m >= 60 ? tx(lang, 'calHours', { n: m / 60 }) : tx(lang, 'calMinutes', { n: m });
}

/** Creates a calendar event (Google or Outlook) holding the meeting's join link. The calendar provider sends any invitations. */
export function AddToCalendarDialog({ lang, token, meeting, onClose, api = calendarApi, navigate = (u) => window.location.assign(u), now }: AddToCalendarDialogProps) {
  const open = meeting !== null;
  const [status, setStatus] = useState<ProviderStatus[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [provider, setProvider] = useState<CalProvider>('google');
  const [start, setStart] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [attendees, setAttendees] = useState('');
  const [busy, setBusy] = useState(false);
  const [errKey, setErrKey] = useState<Key | null>(null);
  const [eventUrl, setEventUrl] = useState<string | null>(null);

  const code = meeting?.code;
  const scheduledAt = meeting?.scheduled_at ?? null;

  useEffect(() => {
    if (!code) return;
    let alive = true;
    setStatus(null);
    setLoadFailed(false);
    setErrKey(null);
    setEventUrl(null);
    setAttendees('');
    setStart(toLocalInput(defaultStart(scheduledAt, now ?? new Date())));
    api
      .status(token)
      .then((s) => {
        if (!alive) return;
        setStatus(s);
        const pick = s.find((p) => p.connected) ?? s.find((p) => p.configured);
        if (pick) setProvider(pick.provider);
      })
      .catch(() => alive && setLoadFailed(true));
    return () => {
      alive = false;
    };
    // `now` and `api` are injected for tests and stable in the app; reloading on them would reset the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, token]);

  const configured = (status ?? []).filter((p) => p.configured);
  const current = status?.find((p) => p.provider === provider);
  const connected = Boolean(current?.connected);

  const connect = async () => {
    setBusy(true);
    setErrKey(null);
    try {
      const { url } = await api.start(token, provider);
      navigate(url);
    } catch (e) {
      setErrKey(calendarErrorKey(e instanceof ApiError ? e.status : 0));
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await api.disconnect(token, provider);
      setStatus((s) => (s ? s.map((p) => (p.provider === provider ? { ...p, connected: false } : p)) : s));
    } catch (e) {
      setErrKey(calendarErrorKey(e instanceof ApiError ? e.status : 0));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !code) return;
    setErrKey(null);
    const built = buildEventBody(provider, start, minutes, attendees);
    if (!built.ok) {
      setErrKey(built.error);
      return;
    }
    setBusy(true);
    try {
      const r = await api.createEvent(token, code, built.body);
      setEventUrl(typeof r.eventUrl === 'string' && r.eventUrl.startsWith('https://') ? r.eventUrl : null);
      if (!r.eventUrl) setErrKey('calFailed');
    } catch (err) {
      const key = calendarErrorKey(err instanceof ApiError ? err.status : 0);
      setErrKey(key);
      // The stored connection is gone (expired or revoked): show the connect button again.
      if (key === 'calReconnect') setStatus((s) => (s ? s.map((p) => (p.provider === provider ? { ...p, connected: false } : p)) : s));
    } finally {
      setBusy(false);
    }
  };

  const canCreate = connected && !eventUrl;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      closeLabel={t(lang, 'uiClose')}
      title={tx(lang, 'calTitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t(lang, 'cancel')}
          </Button>
          {canCreate ? (
            <Button variant="primary" type="submit" form={FORM_ID} loading={busy} data-testid="cal-create">
              {tx(lang, 'calCreate')}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="cal">
        <p className="cal__lead">{meeting ? `${meeting.title}. ${tx(lang, 'calLead')}` : tx(lang, 'calLead')}</p>
        {errKey ? (
          <div data-testid="cal-error">
            <Alert tone="danger">{tx(lang, errKey)}</Alert>
          </div>
        ) : null}

        {loadFailed ? (
          <Alert tone="danger">{tx(lang, 'calFailed')}</Alert>
        ) : status === null ? (
          <p className="cal__loading" role="status">
            <Spinner /> {tx(lang, 'calLoading')}
          </p>
        ) : configured.length === 0 ? (
          <div data-testid="cal-none">
            <Alert tone="info">{tx(lang, 'calNone')}</Alert>
          </div>
        ) : (
          <>
            <Select label={tx(lang, 'calProvider')} value={provider} onChange={(e) => setProvider(e.target.value as CalProvider)} data-testid="cal-provider">
              {configured.map((p) => (
                <option key={p.provider} value={p.provider}>
                  {tx(lang, PROVIDER_LABEL[p.provider])}
                </option>
              ))}
            </Select>

            {!connected ? (
              <div className="cal__connect">
                <p>{tx(lang, 'calConnectLead')}</p>
                <Button variant="highlight" loading={busy} data-testid="cal-connect" onClick={() => void connect()}>
                  {tx(lang, 'calConnect', { provider: tx(lang, PROVIDER_LABEL[provider]) })}
                </Button>
              </div>
            ) : eventUrl ? (
              <div className="cal__done" role="status">
                <Badge tone="success">{tx(lang, 'calCreated')}</Badge>
                <a className="cal__link" href={eventUrl} target="_blank" rel="noopener noreferrer" data-testid="cal-event-link">
                  {tx(lang, 'calOpenEvent')}
                </a>
              </div>
            ) : (
              <form id={FORM_ID} className="cal__form" onSubmit={(e) => void submit(e)}>
                <div className="cal__row">
                  <Badge tone="success" dot>
                    {tx(lang, 'calConnectedBadge')}
                  </Badge>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void disconnect()} data-testid="cal-disconnect">
                    {tx(lang, 'calDisconnect')}
                  </Button>
                </div>
                <DateTimePicker label={tx(lang, 'calStart')} lang={lang} required value={start} onChange={(e) => setStart(e.target.value)} data-testid="cal-start" />
                <Select label={tx(lang, 'calDuration')} value={String(minutes)} onChange={(e) => setMinutes(Number(e.target.value))} data-testid="cal-duration">
                  {DURATIONS.map((d) => (
                    <option key={d} value={d}>
                      {durationLabel(lang, d)}
                    </option>
                  ))}
                </Select>
                <TextField
                  label={tx(lang, 'calAttendees')}
                  hint={tx(lang, 'calAttendeesHint')}
                  type="text"
                  inputMode="email"
                  autoComplete="off"
                  value={attendees}
                  onChange={(e) => setAttendees(e.target.value)}
                  data-testid="cal-attendees"
                />
              </form>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
