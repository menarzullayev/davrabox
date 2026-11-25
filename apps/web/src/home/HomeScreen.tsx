import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Meeting, TrialStatus } from '../api';
import { t, type Key, type Lang } from '../i18n';
import { Alert, Avatar, Button, IconLogout, IconPlus, IconShieldCheck, Logo, ToastProvider, useToast, type ThemeChoice } from '../ui';
import { JoinCard, type JoinCardHandle } from './JoinCard';
import { NewMeetingDialog, type NewMeetingData } from './NewMeetingDialog';
import { AppearanceControls } from './AppearanceControls';
import { TimelineView, copyJoinLink } from './Timeline';
import { PlanPanel } from './PlanPanel';
import { displayName, firstName, formatCode, formatDay, greetingSlot, groupMeetings, planSummary, type ProfileLike, type TimelineMeeting } from './logic';
import { dayNames, tx } from './text';
import { AddToCalendarDialog } from '../calendar/AddToCalendarDialog';
import { useCalendarReturn } from '../calendar/useCalendarReturn';
import { E2eeLinkDialog } from '../e2ee/E2eeLinkDialog';
import { buildShareLink, loadStoredKey } from '../e2ee/keys';

export interface HomeScreenProps {
  lang: Lang;
  onLang: (l: Lang) => void;
  theme: ThemeChoice;
  onTheme: (v: ThemeChoice) => void;
  relayMode: boolean;
  onRelayMode: (v: boolean) => void;
  profile: ProfileLike | undefined;
  isAdmin: boolean;
  /** null while the first load is running. */
  meetings: Meeting[] | null;
  error: Key | null;
  onDismissError: () => void;
  /** Code carried by ?join= or kept across the sign-in redirect. */
  initialCode: string;
  onJoin: (code: string, passcode?: string) => Promise<void>;
  onCreate: (data: NewMeetingData) => Promise<Meeting>;
  onSignOut: () => void;
  /** Free-trial notice ("ends in less than N days"); omitted or null for paid organizations. */
  banner?: { key: Key; n?: number } | null;
  /** The organization's trial status; the "Plan & Limits" card shows for trial organizations only. */
  trial?: TrialStatus | null;
  /** Bearer token for the calendar integration; when set, hosts can add a meeting to Google Calendar or Outlook. */
  calendarToken?: string;
  /** The most the organization allows for guests (shown in the new-meeting dialog). */
  guestMax?: 'off' | 'waiting_room' | 'open';
  /** Injected clock (tests, lab); the real clock ticks every 30 s when omitted. */
  now?: Date;
}

const GREETING: Record<ReturnType<typeof greetingSlot>, Key> = {
  morning: 'hGreetMorning',
  day: 'hGreetDay',
  evening: 'hGreetEvening',
  night: 'hGreetNight',
};

function useClock(fixed?: Date): Date {
  const [clock, setClock] = useState(() => fixed ?? new Date());
  useEffect(() => {
    if (fixed) {
      setClock(fixed);
      return;
    }
    const id = setInterval(() => setClock(new Date()), 30_000);
    return () => clearInterval(id);
  }, [fixed]);
  return clock;
}

function HomeBody(props: HomeScreenProps) {
  const { lang, meetings, onJoin, onCreate } = props;
  const toast = useToast();
  const clock = useClock(props.now);
  const joinCard = useRef<JoinCardHandle>(null);
  const [dialog, setDialog] = useState(false);
  const [joiningCode, setJoiningCode] = useState<string | null>(null);
  const [calendarFor, setCalendarFor] = useState<Meeting | null>(null);
  const [e2eeLink, setE2eeLink] = useState<string | null>(null);
  useCalendarReturn(lang, toast);

  const timeline = useMemo(() => (meetings ? groupMeetings(meetings, clock) : null), [meetings, clock]);
  const plan = planSummary(props.trial, clock);
  const name = firstName(props.profile);
  const greeting = tx(lang, GREETING[greetingSlot(clock)]);

  const joinRow = useCallback(
    async (m: TimelineMeeting) => {
      // A protected meeting needs the passcode first: hand over to the join form instead of failing on the server.
      if (m.has_passcode && !m.is_host) {
        joinCard.current?.askPasscode(m.code);
        document.getElementById('hm-join-h')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
        return;
      }
      setJoiningCode(m.code);
      try {
        await onJoin(m.code);
      } finally {
        setJoiningCode(null);
      }
    },
    [onJoin],
  );

  const copyRow = useCallback(
    async (m: TimelineMeeting) => {
      const ok = await copyJoinLink(location.origin, m.code);
      toast(ok ? { tone: 'success', title: tx(lang, 'hLinkCopied') } : { tone: 'danger', title: tx(lang, 'hCopyFailed') });
      return ok;
    },
    [lang, toast],
  );

  return (
    <>
      <main id="hm-main" className="home hm-main" tabIndex={-1}>
        <section className="hm-hero">
          <p className="hm-date">{formatDay(clock, dayNames(lang))}</p>
          <h1 className="hm-greeting">{name ? `${greeting}, ${name}` : greeting}</h1>
        </section>

        {props.banner ? (
          <Alert tone="info" className="ln-trial">
            {tx(lang, props.banner.key, props.banner.n === undefined ? undefined : { n: props.banner.n })}
          </Alert>
        ) : null}

        {props.error ? (
          <Alert tone="danger" onDismiss={props.onDismissError} dismissLabel={t(lang, 'uiDismiss')} className="hm-error">
            {t(lang, props.error)}
          </Alert>
        ) : null}

        <div className="hm-actions">
          <JoinCard ref={joinCard} lang={lang} initialCode={props.initialCode} onJoin={onJoin} passcodeNeeded={props.error === 'errWrongPasscode'} />
          <section className="hm-card hm-new" aria-labelledby="hm-new-h">
            <h2 className="hm-card__title" id="hm-new-h">
              {tx(lang, 'hNewTitle')}
            </h2>
            <p className="hm-card__lead">{tx(lang, 'hNewLead')}</p>
            <Button variant="highlight" size="lg" fullWidth icon={<IconPlus />} data-testid="new-meeting" onClick={() => setDialog(true)}>
              {tx(lang, 'hNewAction')}
            </Button>
          </section>
        </div>

        <section className="hm-timeline" aria-labelledby="hm-meetings-h">
          <h2 className="hm-section" id="hm-meetings-h">
            {t(lang, 'meetings')}
          </h2>
          <TimelineView lang={lang} timeline={timeline} now={clock} joiningCode={joiningCode} onJoin={(m) => void joinRow(m)} onCopy={copyRow} onNew={() => setDialog(true)} onCalendar={props.calendarToken ? setCalendarFor : undefined} />
        </section>

        {plan ? <PlanPanel lang={lang} plan={plan} /> : null}

        <footer className="hm-footer">{tx(lang, 'hBrandLine')}</footer>
      </main>

      <NewMeetingDialog
        lang={lang}
        open={dialog}
        onClose={() => setDialog(false)}
        onCreate={onCreate}
        calendar={Boolean(props.calendarToken)}
        guestMax={props.guestMax}
        onCreated={(m, opts) => {
          setDialog(false);
          if (m.e2ee) {
            // The host's tab holds the key (made at creation): show the full link once so it can be shared.
            const key = loadStoredKey(m.code);
            if (key) setE2eeLink(buildShareLink(location.origin, m.code, key));
          }
          if (opts?.calendar) setCalendarFor(m);
          toast({ tone: 'success', title: tx(lang, 'hCreated'), description: tx(lang, 'hCreatedDesc', { title: m.title, code: formatCode(m.code) }) });
        }}
      />
      <E2eeLinkDialog lang={lang} link={e2eeLink} onClose={() => setE2eeLink(null)} />
      {props.calendarToken ? <AddToCalendarDialog lang={lang} token={props.calendarToken} meeting={calendarFor} onClose={() => setCalendarFor(null)} /> : null}
    </>
  );
}

/** The signed-in home screen: greeting, join by code or link, new meeting, and today's meetings as a timeline. */
export function HomeScreen(props: HomeScreenProps) {
  const { lang } = props;
  const who = displayName(props.profile);
  return (
    <ToastProvider dismissLabel={t(lang, 'uiDismiss')} regionLabel={tx(lang, 'hToasts')}>
      <div className="hm-page">
        <a className="hm-skip" href="#hm-main">
          {tx(lang, 'hSkip')}
        </a>
        <header className="hm-header">
          <div className="hm-header__in">
            <Logo height={30} title={t(lang, 'appName')} />
            <span className="hm-spacer" />
            {props.isAdmin ? (
              <a href="/admin" className="dx-btn hm-admin" data-variant="ghost" data-size="sm" title={t(lang, 'admLink')} data-testid="admin-link">
                <span className="dx-btn__label">
                  <IconShieldCheck size={18} />
                  <span className="hm-admin__label">{t(lang, 'admLink')}</span>
                </span>
              </a>
            ) : null}
            {who ? (
              <span className="hm-who" title={who}>
                <Avatar name={who} size={32} decorative />
                <span className="hm-who__name">{who}</span>
              </span>
            ) : null}
            <AppearanceControls
              lang={lang}
              onLang={props.onLang}
              theme={props.theme}
              onTheme={props.onTheme}
              relay={{ value: props.relayMode, onChange: props.onRelayMode }}
            />
            <Button variant="ghost" size="sm" icon={<IconLogout size={18} />} className="hm-signout" onClick={props.onSignOut}>
              <span className="hm-signout__label">{t(lang, 'signOut')}</span>
            </Button>
          </div>
        </header>
        <HomeBody {...props} />
      </div>
    </ToastProvider>
  );
}
