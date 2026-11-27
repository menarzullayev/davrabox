import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { GuestMode, Meeting, OnboardingView, TrialStatus } from '../api';
import { GetStarted, VerifyReminder } from './GetStarted';
import { MeetingGuestsDialog } from './MeetingGuestsDialog';
import { t, type Key, type Lang } from '../i18n';
import { Alert, Button, Dialog, IconCalendar, IconClock, IconPlus, ToastProvider, useToast, type ThemeChoice } from '../ui';
import { JoinCard, type JoinCardHandle } from './JoinCard';
import { NewMeetingDialog, type NewMeetingData } from './NewMeetingDialog';
import { TimelineView, copyJoinLink } from './Timeline';
import { PlanPanel } from './PlanPanel';
import { displayName, firstName, formatCode, formatDay, greetingSlot, groupMeetings, planSummary, type ProfileLike, type TimelineMeeting } from './logic';
import { dayNames, tx } from './text';
import { AssistantLauncher } from '../help/AssistantLauncher';
import { freshToken } from '../auth';
import { AddToCalendarDialog } from '../calendar/AddToCalendarDialog';
import { useCalendarReturn } from '../calendar/useCalendarReturn';
import { E2eeLinkDialog } from '../e2ee/E2eeLinkDialog';
import { buildShareLink, loadStoredKey } from '../e2ee/keys';
import { AppShell } from '../shell/AppShell';
import { navigate, pathFor, type AppSection } from '../shell/nav';
import type { HomeApi } from './homeApi';
import { PersonalRoomCard } from './PersonalRoomCard';
import { RecentActivity } from './RecentActivity';
import { PRICING_HREF } from './PlanPanel';
import { DevicesPage } from '../pages/DevicesPage';
import { RecordingsPage } from '../pages/RecordingsPage';
import { WhiteboardsPage } from '../pages/WhiteboardsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { ProfilePage } from '../profile/ProfilePage';
import type { ProfileApi } from '../profile/profileApi';
import type { SettingsApi } from '../settings/MySettings';

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
  /** A one-off notice, e.g. "the host ended the meeting" after a call closed for everyone. */
  notice?: string | null;
  onDismissNotice?: () => void;
  /** The organization's trial status; the "Plan & Limits" card shows for trial organizations only. */
  trial?: TrialStatus | null;
  /** Bearer token for the calendar integration; when set, hosts can add a meeting to Google Calendar or Outlook. */
  calendarToken?: string;
  /** The most the organization allows for guests (shown in the new-meeting dialog). */
  guestMax?: 'off' | 'waiting_room' | 'open';
  /** Host side: change an existing meeting's guest setting (the list reloads afterwards). */
  onSetGuests?: (code: string, mode: GuestMode) => Promise<void>;
  /** Injected clock (tests, lab); the real clock ticks every 30 s when omitted. */
  now?: Date;
  /** The "Get started" checklist (decision 5); null/undefined hides the card and the reminder. */
  onboarding?: OnboardingView | null;
  /** The signed-in address (shown in the unverified-email reminder). */
  email?: string;
  onTestDevices?: () => void;
  onSendVerification?: () => Promise<void>;
  onDismissOnboarding?: () => void;
  /** The section of the signed-in app shown (left panel / tab bar); the home screen when omitted. */
  section?: AppSection;
  /** Server calls of the home package (personal room, activity, recordings, device check); the blocks need it. */
  homeApi?: HomeApi;
  /** Server calls of /app/profile. */
  profileApi?: ProfileApi;
  /** The sign-in session id (profile: "this device", account linking). */
  sid?: string;
  /** The person's picture, shown in the header. */
  avatarUrl?: string | null;
  /** After "sign out of all sessions". */
  onSignedOutEverywhere?: () => void;
  onAvatarChange?: (url: string | null) => void;
  /** "My settings". */
  settingsApi?: SettingsApi;
  /** Host: cancel a meeting (the list reloads afterwards). */
  onCancelMeeting?: (code: string) => Promise<void>;
  /** A passcode carried by the join link. */
  initialPasscode?: string;
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
  const [dialog, setDialog] = useState<'new' | 'schedule' | null>(null);
  const [joiningCode, setJoiningCode] = useState<string | null>(null);
  const [calendarFor, setCalendarFor] = useState<Meeting | null>(null);
  const [guestsFor, setGuestsFor] = useState<Meeting | null>(null);
  const [e2eeLink, setE2eeLink] = useState<string | null>(null);
  const [reminderClosed, setReminderClosed] = useState(false);
  useCalendarReturn(lang, toast);
  // "New" from the tab bar of another screen (the admin console) lands here as /app#new.
  useEffect(() => {
    if (location.hash === '#new') {
      setDialog('new');
      history.replaceState({}, document.title, location.pathname);
    }
  }, []);
  const section = props.section ?? 'home';
  // "My settings" that shape this screen: new-meeting defaults, the passcode requirement, instant meetings in the personal room.
  const [my, setMy] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (!props.settingsApi) return;
    props.settingsApi.load().then((v) => setMy(Object.fromEntries(v.items.map((i) => [i.key, i.value]))), () => undefined);
  }, [props.settingsApi, dialog]);
  const [cancelFor, setCancelFor] = useState<TimelineMeeting | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const newMeeting = useCallback(async () => {
    if (my['personalRoomInstant'] === true && props.homeApi) {
      try {
        const v = await props.homeApi.personalRoom();
        if (v.room) {
          await onJoin(v.room.code);
          return;
        }
      } catch {
        /* fall back to the form */
      }
    }
    setDialog('new');
  }, [my, props.homeApi, onJoin]);
  const ob = props.onboarding;
  // The card shows until it is closed or every step is done; the email reminder takes over when the card is gone.
  const showCard = Boolean(ob && !ob.dismissed && ob.steps.some((s) => !s.done));
  const showReminder = Boolean(ob && !ob.emailVerified && !showCard && !reminderClosed && props.email);

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

  const timelineView = (
    <TimelineView
      lang={lang}
      timeline={timeline}
      now={clock}
      joiningCode={joiningCode}
      onJoin={(m) => void joinRow(m)}
      onCopy={copyRow}
      onNew={() => setDialog('new')}
      onCalendar={props.calendarToken ? setCalendarFor : undefined}
      onGuests={props.onSetGuests && props.guestMax && props.guestMax !== 'off' ? setGuestsFor : undefined}
      onCancel={props.onCancelMeeting ? setCancelFor : undefined}
    />
  );
  const relay = { value: props.relayMode, onChange: props.onRelayMode };

  let page: ReactNode;
  if (section === 'meetings') {
    page = (
      <main id="hm-main" className="home hm-main" tabIndex={-1} data-testid="meetings-page">
        <header className="pg-head">
          <h1 className="pg-title" id="hm-meetings-h">
            {t(lang, 'meetings')}
          </h1>
          <div className="pg-actions">
            <Button variant="primary" icon={<IconPlus size={18} />} data-testid="meetings-new" onClick={() => setDialog('new')}>
              {tx(lang, 'qkNew')}
            </Button>
            <Button variant="secondary" icon={<IconClock size={18} />} data-testid="meetings-schedule" onClick={() => setDialog('schedule')}>
              {tx(lang, 'qkSchedule')}
            </Button>
          </div>
        </header>
        {props.error ? (
          <Alert tone="danger" onDismiss={props.onDismissError} dismissLabel={t(lang, 'uiDismiss')} className="hm-error">
            {t(lang, props.error)}
          </Alert>
        ) : null}
        <section className="hm-timeline hm-timeline--page" aria-labelledby="hm-meetings-h">
          {timelineView}
        </section>
      </main>
    );
  } else if (section === 'recordings' && props.homeApi) {
    page = <RecordingsPage lang={lang} api={props.homeApi} />;
  } else if (section === 'whiteboards') {
    page = <WhiteboardsPage lang={lang} />;
  } else if (section === 'settings') {
    page = <SettingsPage lang={lang} onLang={props.onLang} theme={props.theme} onTheme={props.onTheme} relay={relay} settingsApi={props.settingsApi} />;
  } else if (section === 'profile' && props.profileApi) {
    page = <ProfilePage lang={lang} api={props.profileApi} sid={props.sid} onSignedOutEverywhere={props.onSignedOutEverywhere ?? props.onSignOut} onAvatarChange={props.onAvatarChange} />;
  } else if (section === 'devices' && props.homeApi) {
    page = (
      <DevicesPage
        lang={lang}
        api={props.homeApi}
        onDone={() => {
          props.onTestDevices?.();
          navigate(pathFor('home'));
        }}
      />
    );
  } else {
    page = (
      <main id="hm-main" className="home hm-main" tabIndex={-1}>
        <section className="hm-hero">
          <p className="hm-date">{formatDay(clock, dayNames(lang))}</p>
          <h1 className="hm-greeting">{name ? `${greeting}, ${name}` : greeting}</h1>
        </section>

        {props.notice ? (
          <div data-testid="home-notice">
            <Alert tone="info" className="hm-error" onDismiss={props.onDismissNotice} dismissLabel={t(lang, 'uiDismiss')}>
              {props.notice}
            </Alert>
          </div>
        ) : null}

        {props.banner ? (
          <div data-testid="trial-reminder">
            <Alert tone="info" className="ln-trial">
              <span className="hm-verify">
                <span>{tx(lang, props.banner.key, props.banner.n === undefined ? undefined : { n: props.banner.n })}</span>
                <a className="dx-btn" data-variant="ghost" data-size="sm" href={PRICING_HREF} data-testid="trial-upgrade">
                  <span className="dx-btn__label">{tx(lang, 'plUpgrade')}</span>
                </a>
              </span>
            </Alert>
          </div>
        ) : null}

        {props.error ? (
          <Alert tone="danger" onDismiss={props.onDismissError} dismissLabel={t(lang, 'uiDismiss')} className="hm-error">
            {t(lang, props.error)}
          </Alert>
        ) : null}

        {showReminder && ob ? (
          <VerifyReminder lang={lang} email={props.email ?? ''} canSend={ob.canSendVerification && Boolean(props.onSendVerification)} onSend={props.onSendVerification ?? (async () => undefined)} onDismiss={() => setReminderClosed(true)} />
        ) : null}

        {/* Quick actions (owner decision 2): New meeting, Join with the inline code field, Schedule. */}
        <div className="hm-actions">
          <JoinCard ref={joinCard} lang={lang} initialCode={props.initialCode} initialPasscode={props.initialPasscode} onJoin={onJoin} passcodeNeeded={props.error === 'errWrongPasscode'} />
          <section className="hm-card hm-new" aria-labelledby="hm-new-h">
            <h2 className="hm-card__title" id="hm-new-h">
              {tx(lang, 'hNewTitle')}
            </h2>
            <p className="hm-card__lead">{tx(lang, 'hNewLead')}</p>
            <div className="hm-new__buttons">
              <Button variant="highlight" size="lg" fullWidth icon={<IconPlus />} data-testid="new-meeting" onClick={() => void newMeeting()}>
                {tx(lang, 'hNewAction')}
              </Button>
              <Button variant="secondary" size="lg" fullWidth icon={<IconCalendar />} data-testid="schedule-meeting" onClick={() => setDialog('schedule')}>
                {tx(lang, 'qkSchedule')}
              </Button>
            </div>
          </section>
        </div>

        {showCard && ob ? (
          <GetStarted
            lang={lang}
            view={ob}
            onTestDevices={() => navigate(pathFor('devices'))}
            onNewMeeting={() => setDialog('new')}
            onSendVerification={props.onSendVerification ?? (async () => undefined)}
            onDismiss={props.onDismissOnboarding ?? (() => undefined)}
          />
        ) : null}

        {props.homeApi || plan ? (
          <div className="hm-duo">
            {props.homeApi ? <PersonalRoomCard lang={lang} api={props.homeApi} name={displayName(props.profile)} onJoin={(c) => onJoin(c)} /> : null}
            {plan ? <PlanPanel lang={lang} plan={plan} /> : null}
          </div>
        ) : null}

        <section className="hm-timeline" aria-labelledby="hm-meetings-h">
          <h2 className="hm-section" id="hm-meetings-h">
            {t(lang, 'meetings')}
          </h2>
          {timelineView}
        </section>

        {props.homeApi ? <RecentActivity lang={lang} api={props.homeApi} /> : null}

        <footer className="hm-footer">{tx(lang, 'hBrandLine')}</footer>
      </main>
    );
  }

  return (
    <AppShell
      lang={lang}
      onLang={props.onLang}
      theme={props.theme}
      onTheme={props.onTheme}
      relay={relay}
      current={section}
      isAdmin={props.isAdmin}
      who={displayName(props.profile)}
      whoId={typeof props.profile?.sub === 'string' ? props.profile.sub : undefined}
      whoAvatar={props.avatarUrl ?? undefined}
      onSignOut={props.onSignOut}
      onNew={() => void newMeeting()}
    >
      {page}
      <NewMeetingDialog
        lang={lang}
        open={dialog !== null}
        schedule={dialog === 'schedule'}
        defaults={{
          waitingRoom: typeof my['waitingRoom'] === 'boolean' ? (my['waitingRoom'] as boolean) : undefined,
          e2ee: my['e2ee'] === true,
          guests: typeof my['guestMode'] === 'string' ? (my['guestMode'] as GuestMode) : undefined,
          requirePasscode: my['requirePasscode'] === true,
          embedPasscode: my['embedPasscode'] === true,
        }}
        onClose={() => setDialog(null)}
        onCreate={onCreate}
        calendar={Boolean(props.calendarToken)}
        guestMax={props.guestMax}
        onCreated={(m, opts) => {
          const scheduled = dialog === 'schedule';
          setDialog(null);
          if (m.e2ee) {
            // The host's tab holds the key (made at creation): show the full link once so it can be shared.
            const key = loadStoredKey(m.code);
            if (key) setE2eeLink(buildShareLink(location.origin, m.code, key));
          }
          if (opts?.calendar) setCalendarFor(m);
          toast({ tone: 'success', title: tx(lang, scheduled ? 'schedDone' : 'hCreated'), description: tx(lang, 'hCreatedDesc', { title: m.title, code: formatCode(m.code) }) });
        }}
      />
      <E2eeLinkDialog lang={lang} link={e2eeLink} onClose={() => setE2eeLink(null)} />
      <Dialog
        open={cancelFor !== null}
        onClose={() => setCancelFor(null)}
        closeLabel={t(lang, 'uiClose')}
        title={tx(lang, 'tlCancelTitle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCancelFor(null)}>
              {t(lang, 'cancel')}
            </Button>
            <Button
              variant="danger"
              loading={cancelBusy}
              data-testid="cancel-confirm"
              onClick={() => {
                const m = cancelFor;
                if (!m || !props.onCancelMeeting) return;
                setCancelBusy(true);
                props
                  .onCancelMeeting(m.code)
                  .then(
                    () => toast({ tone: 'success', title: tx(lang, 'tlCancelDone') }),
                    () => toast({ tone: 'danger', title: t(lang, 'errGeneric') }),
                  )
                  .finally(() => {
                    setCancelBusy(false);
                    setCancelFor(null);
                  });
              }}
            >
              {tx(lang, 'tlCancel')}
            </Button>
          </>
        }
      >
        <p className="hm-new__lead">{tx(lang, 'tlCancelBody', { title: cancelFor?.title ?? '' })}</p>
      </Dialog>
      {props.onSetGuests ? <MeetingGuestsDialog lang={lang} meeting={guestsFor} max={props.guestMax ?? 'off'} onSave={props.onSetGuests} onClose={() => setGuestsFor(null)} /> : null}
      {props.calendarToken ? <AddToCalendarDialog lang={lang} token={props.calendarToken} meeting={calendarFor} onClose={() => setCalendarFor(null)} /> : null}
    </AppShell>
  );
}

/** The signed-in home screen: greeting, join by code or link, new meeting, and today's meetings as a timeline. */
/** The help assistant gets the session token when there is one (only a platform owner's token changes its answers). */
const assistantToken = () => freshToken().catch(() => null);

export function HomeScreen(props: HomeScreenProps) {
  const { lang } = props;
  return (
    <ToastProvider dismissLabel={t(lang, 'uiDismiss')} regionLabel={tx(lang, 'hToasts')}>
      <HomeBody {...props} />
      <AssistantLauncher lang={lang} page="home" token={assistantToken} />
    </ToastProvider>
  );
}
