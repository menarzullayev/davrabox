import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import type { User } from 'oidc-client-ts';
import { api, onSessionLost, type GuestMode, type JoinedResult, type Meeting, type OnboardingView, type TrialStatus } from './api';
import { appErrorKey as errorKey } from './errors';
import { trialBanner } from './landing/trial';
import { consumeReturnPath, isAdminPath, rememberReturnPath } from './admin/helpers';
import { isOrgAdmin, needsOrganization } from './admin/jwt';
import { currentUser, freshToken, manager, signIn, takeReturnTo } from './auth';
import { profileApiFor } from './profile/profileApi';
import { setDisplay } from './profile/display';
import { HostWait, JoinNotice } from './settings/JoinRules';
import { passcodeFromSearch } from './home/link-passcode';
import { ApiError } from './api';
import { recoverSession } from './session-recovery';
import { Call } from './Call';
import { t, type Key, type Lang } from './i18n';
import { LoadingScreen, SignInScreen } from './home/AuthScreens';
import { HomeScreen } from './home/HomeScreen';
import { OrgSetupScreen } from './home/OrgSetup';
import type { NewMeetingData } from './home/NewMeetingDialog';
import { Waiting } from './home/Waiting';
import { PreJoin, readSkipPreJoin, type MediaChoice } from './home/PreJoin';
import { createMeetingWithKey } from './e2ee/create';
import { takeKeyFromLocation } from './e2ee/keys';
import { startPrefsSync, usePrefs } from './prefs';
import { AppearanceControls } from './home/AppearanceControls';
import { homeApiFor } from './home/homeApi';
import { AppShell } from './shell/AppShell';
import { navigate, sectionFromPath, useLocationPath } from './shell/nav';
import { ToastProvider } from './ui';
import { displayName } from './home/logic';

// Loaded on demand so the home/call bundle does not grow for non-admins.
const AdminApp = lazy(() => import('./admin/AdminApp').then((m) => ({ default: m.AdminApp })));

/** Skips the pre-join screen for someone who ticked "do not show this next time". */
function withMedia(v: { result: JoinedResult; code: string; media?: MediaChoice }): { result: JoinedResult; code: string; media?: MediaChoice } {
  return readSkipPreJoin() ? { ...v, media: { mic: true, cam: true } } : v;
}

export function App() {
  const { lang, theme, setLang: changeLang, setTheme: changeTheme } = usePrefs();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [relayMode, setRelayMode] = useState(() => {
    try {
      return localStorage.getItem('relayMode') === '1';
    } catch {
      return false;
    }
  });
  // A meeting link (?join=<code>, e.g. from the desktop deep link davrabox://join/<code>) pre-fills the code field and
  // survives the sign-in redirect through sessionStorage. Only well-formed codes are accepted.
  const [pendingCode, setPendingCode] = useState(() => {
    try {
      // An E2EE link carries its key after the #: move it into sessionStorage and drop it from the address bar first.
      takeKeyFromLocation(location, history);
      const q = new URLSearchParams(location.search).get('join');
      if (q && /^[0-9]{11,12}$/.test(q)) {
        sessionStorage.setItem('pendingJoin', q);
        history.replaceState({}, document.title, location.pathname);
      }
      return sessionStorage.getItem('pendingJoin') ?? '';
    } catch {
      return '';
    }
  });
  // A passcode in the join link ("put the passcode in the link"): kept for this tab only, offered in the join form.
  const [pendingPwd] = useState(() => {
    try {
      const v = passcodeFromSearch(location.search);
      if (v) sessionStorage.setItem('pendingPwd', v);
      return sessionStorage.getItem('pendingPwd') ?? '';
    } catch {
      return '';
    }
  });
  const [err, setErr] = useState<Key | null>(null);
  // Organization join rules (settings package): the notice to accept, and waiting while the host has not started.
  const [notice, setNotice] = useState<{ text: string; retry: () => void } | null>(null);
  const [hostWait, setHostWait] = useState<{ retry: () => void } | null>(null);
  const [joined, setJoined] = useState<{ result: JoinedResult; code: string; media?: MediaChoice } | null>(null);
  const [waiting, setWaiting] = useState<{ code: string; requestId: string } | null>(null);
  // Guest (no account) state: a joined call or a waiting request with its own session token.
  const [guestJoined, setGuestJoined] = useState<{ result: JoinedResult; code: string; media?: MediaChoice } | null>(null);
  const [guestWaiting, setGuestWaiting] = useState<{ code: string; requestId: string; guestToken: string } | null>(null);
  const guestGetToken = useCallback(async () => guestJoined?.result.guestToken ?? '', [guestJoined]);
  const [guestMax, setGuestMax] = useState<GuestMode>('off');
  // Set when the host ended the call for everyone; shown once on the screen the person lands on.
  const [ended, setEnded] = useState(false);

  const loc = useLocationPath();
  const adminView = isAdminPath(loc.path);
  const section = sectionFromPath(loc.path);

  useEffect(() => {
    currentUser()
      .then((u) => {
        // The Keycloak redirect always lands on "/": go back to the admin console if that is where the user was headed.
        if (u && consumeReturnPath()) navigate('/admin', { replace: true });
        // Back from an identity-provider page the profile opened (password, 2FA, passkey, account linking).
        const back = u ? takeReturnTo() : null;
        if (back) navigate(back, { replace: true });
        setUser(u);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    const onRenew = (u: User) => setUser(u);
    manager.events.addUserLoaded(onRenew);
    return () => manager.events.removeUserLoaded(onRenew);
  }, []);

  // A first sign-in through Google or Microsoft has no organisation yet (decision 4): it gets the set-up screen and none of
  // the organisation's API calls (they would answer 401 and end the session).
  const orgless = needsOrganization(user?.access_token);
  const token = user && !orgless ? user.access_token : '';
  const [onboarding, setOnboarding] = useState<OnboardingView | null>(null);
  const homeApi = useMemo(() => homeApiFor(freshToken), []);
  const profileApi = useMemo(() => profileApiFor(freshToken), []);
  const settingsApi = useMemo(() => ({ load: async () => api.mySettings(await freshToken()), save: async (p: Record<string, unknown>) => api.saveMySettings(await freshToken(), p) }), []);
  // The profile's picture and display choices (time zone, formats) apply on every screen.
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    api.profile(token).then(
      (p) => {
        setAvatarUrl(p.avatarUrl);
        setDisplay({ timeZone: p.timeZone, dateFormat: p.dateFormat, timeFormat: p.timeFormat });
      },
      () => undefined,
    );
  }, [token, loc.path]);
  const loadOnboarding = useCallback(() => {
    if (!token) return;
    api.onboarding(token).then(setOnboarding).catch(() => setOnboarding(null)); // the card is optional: no card on failure
  }, [token]);
  useEffect(loadOnboarding, [loadOnboarding]);
  const markOnboarding = useCallback(
    (patch: { devicesTested?: true; meetingJoined?: true; dismissed?: true }) => {
      if (!token) return;
      api.setOnboarding(token, patch).then(setOnboarding).catch(() => undefined);
    },
    [token],
  );
  // The identity provider lost the session (API answers 401 to our own token): back to the sign-in screen.
  useEffect(() => {
    onSessionLost((sent) => {
      if (!sent || sent !== token) return;
      recoverSession({ now: Date.now, store: sessionStorage, removeUser: () => manager.removeUser(), goHome: () => location.assign('/app') });
    });
    return () => onSessionLost(null);
  }, [token]);
  // The person's saved look follows them to every device, inside the organization's rules.
  useEffect(() => {
    if (!token) return undefined;
    let stop: (() => void) | undefined;
    let gone = false;
    void startPrefsSync(freshToken).then((s) => (gone ? s() : (stop = s)));
    return () => {
      gone = true;
      stop?.();
    };
  }, [token]);
  // Free-trial end date of the organization (null for a paid one); drives the "ends soon" notice on the home screen.
  const [trialStatus, setTrialStatus] = useState<TrialStatus | null>(null);
  const trialEnds = trialStatus?.trial ? trialStatus.endsAt : null;
  useEffect(() => {
    if (!token) return;
    api.trial(token).then(setTrialStatus).catch(() => setTrialStatus(null));
  }, [token]);
  useEffect(() => {
    if (!token) return;
    api.settings(token).then((s) => setGuestMax(s.guestPolicy)).catch(() => setGuestMax('off'));
  }, [token]);
  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      setMeetings(await api.list(token));
    } catch {
      setMeetings((m) => m ?? []);
      setErr('errGeneric');
    }
  }, [token]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // The timeline goes stale while the tab is in the background: reload when the user comes back.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        loadOnboarding(); // the verification link was probably clicked in another tab
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh, loadOnboarding]);
  // Being in a call (one's own or a colleague's) completes "first meeting" (decision 5).
  const inCall = Boolean(joined?.media);
  useEffect(() => {
    if (inCall && onboarding && onboarding.steps.some((s) => s.id === 'meeting' && !s.done)) markOnboarding({ meetingJoined: true });
  }, [inCall, onboarding, markOnboarding]);

  const changeRelay = (v: boolean) => {
    setRelayMode(v);
    try {
      localStorage.setItem('relayMode', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const doJoin = async (c: string, p?: string, accepted = false) => {
    setErr(null);
    setEnded(false);
    const clean = c.replace(/\s+/g, '');
    try {
      const res = await api.join(token, clean, p || undefined, accepted);
      setHostWait(null);
      try {
        sessionStorage.removeItem('pendingJoin');
      } catch {
        /* ignore */
      }
      setPendingCode('');
      if (res.status === 'joined') setJoined(withMedia({ result: res, code: clean }));
      else setWaiting({ code: clean, requestId: res.requestId });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'disclaimer') {
        setNotice({ text: String(e.extra?.['disclaimer'] ?? ''), retry: () => void doJoin(clean, p, true) });
        return;
      }
      if (e instanceof ApiError && e.code === 'host_absent') {
        setHostWait({ retry: () => void doJoin(clean, p, accepted) });
        return;
      }
      setHostWait(null);
      setErr(errorKey(e));
    }
  };

  const doGuestJoin = async (rawCode: string, name: string, passcode?: string, accepted = false): Promise<void> => {
    const clean = rawCode.replace(/\s+/g, '');
    let res;
    try {
      res = await api.guestJoin(clean, name, passcode || undefined, accepted);
      setHostWait(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'disclaimer') {
        setNotice({ text: String(e.extra?.['disclaimer'] ?? ''), retry: () => void doGuestJoin(clean, name, passcode, true).catch(() => undefined) });
        return;
      }
      if (e instanceof ApiError && e.code === 'host_absent') {
        setHostWait({ retry: () => void doGuestJoin(clean, name, passcode, accepted).catch(() => undefined) });
        return;
      }
      setHostWait(null);
      throw e;
    }
    try {
      sessionStorage.removeItem('pendingJoin');
    } catch {
      /* ignore */
    }
    setPendingCode('');
    if (res.status === 'joined') setGuestJoined(withMedia({ result: res, code: clean }));
    else setGuestWaiting({ code: clean, requestId: res.requestId, guestToken: res.guestToken });
  };

  const doCreate = async (d: NewMeetingData): Promise<Meeting> => {
    setErr(null);
    const m = await createMeetingWithKey((body) => api.create(token, body), d); // E2EE: the key is made here and never sent
    await refresh();
    loadOnboarding();
    return m;
  };

  // The admin console header shows the same appearance controls as every other screen.
  const langPicker = <AppearanceControls lang={lang} onLang={changeLang} theme={theme} onTheme={changeTheme} />;

  if (loading) return <LoadingScreen lang={lang} />;

  if (hostWait && !joined && !guestJoined) return <HostWait lang={lang} onRetry={hostWait.retry} onCancel={() => setHostWait(null)} />;
  const noticeDialog = (
    <JoinNotice
      lang={lang}
      text={notice?.text ?? null}
      onCancel={() => setNotice(null)}
      onAccept={() => {
        const n = notice;
        setNotice(null);
        n?.retry();
      }}
    />
  );

  if (guestJoined && !guestJoined.media) {
    return <PreJoin lang={lang} title={guestJoined.result.title} onJoin={(media) => setGuestJoined({ ...guestJoined, media })} onCancel={() => setGuestJoined(null)} />;
  }
  if (guestJoined) {
    return <Call join={guestJoined.result} code={guestJoined.code} guest initialMedia={guestJoined.media} getToken={guestGetToken} lang={lang} onLeave={(info) => { setGuestJoined(null); setEnded(Boolean(info?.ended)); }} />;
  }
  if (guestWaiting) {
    return (
      <Waiting
        lang={lang}
        code={guestWaiting.code}
        requestId={guestWaiting.requestId}
        guestToken={guestWaiting.guestToken}
        onAdmitted={(r) => {
          setGuestJoined(withMedia({ result: r, code: guestWaiting.code }));
          setGuestWaiting(null);
        }}
        onFailed={() => setGuestWaiting(null)}
        onCancel={() => setGuestWaiting(null)}
      />
    );
  }

  if (!user) {
    return (
      <>
      {noticeDialog}
      <SignInScreen
        lang={lang}
        notice={ended ? t(lang, 'meetingEndedByHost') : null}
        onLang={changeLang}
        theme={theme}
        onTheme={changeTheme}
        onSignIn={() => {
          rememberReturnPath(location.pathname);
          void signIn({ lang });
        }}
        initialCode={pendingCode}
        onGuestJoin={doGuestJoin}
        onSignInToJoin={(code) => {
          try {
            sessionStorage.setItem('pendingJoin', code);
          } catch {
            /* storage unavailable: the code is simply asked for again after sign-in */
          }
          rememberReturnPath(location.pathname);
          void signIn({ lang });
        }}
      />
      </>
    );
  }

  if (orgless) {
    const profile = user.profile as { name?: string; email?: string };
    return (
      <OrgSetupScreen
        lang={lang}
        onLang={changeLang}
        theme={theme}
        onTheme={changeTheme}
        name={profile.name ?? ''}
        email={profile.email ?? ''}
        onSignOut={() => void manager.signoutRedirect()}
        onCreate={async (orgName) => {
          await api.setupOrganization(user.access_token, orgName, lang);
          // The new organisation and roles are in the account now: a refreshed token carries them.
          try {
            setUser(await manager.signinSilent());
          } catch {
            await signIn({ lang });
          }
        }}
      />
    );
  }

  if (adminView && !joined && !waiting) {
    return (
      <ToastProvider dismissLabel={t(lang, 'uiDismiss')} regionLabel={t(lang, 'hToasts')}>
        <AppShell
          lang={lang}
          onLang={changeLang}
          theme={theme}
          onTheme={changeTheme}
          relay={{ value: relayMode, onChange: changeRelay }}
          current="admin"
          isAdmin={isOrgAdmin(token)}
          who={displayName(user.profile)}
          whoId={user.profile.sub}
          onSignOut={() => void manager.signoutRedirect()}
          onNew={() => navigate('/app#new')}
        >
          <Suspense fallback={<main className="center">{t(lang, 'admLoading')}</main>}>
            <AdminApp lang={lang} langPicker={langPicker} user={user} onSignOut={() => void manager.signoutRedirect()} />
          </Suspense>
        </AppShell>
      </ToastProvider>
    );
  }

  if (joined && !joined.media) {
    return <PreJoin lang={lang} title={joined.result.title} onJoin={(media) => setJoined({ ...joined, media })} onCancel={() => setJoined(null)} />;
  }

  if (joined) {
    return (
      <Call
        join={joined.result}
        initialMedia={joined.media}
        code={joined.code}
        getToken={freshToken}
        lang={lang}
        guestMax={guestMax}
        onLeave={(info) => {
          setJoined(null);
          setEnded(Boolean(info?.ended));
          void refresh();
        }}
      />
    );
  }

  if (waiting) {
    return (
      <Waiting
        lang={lang}
        code={waiting.code}
        requestId={waiting.requestId}
        onAdmitted={(r) => {
          setJoined(withMedia({ result: r, code: waiting.code }));
          setWaiting(null);
        }}
        onFailed={(e) => {
          setErr(errorKey(e));
          setWaiting(null);
        }}
        onCancel={() => setWaiting(null)}
      />
    );
  }

  return (
    <>
    {noticeDialog}
    <HomeScreen
      lang={lang}
      onLang={changeLang}
      theme={theme}
      onTheme={changeTheme}
      relayMode={relayMode}
      onRelayMode={changeRelay}
      profile={user.profile}
      isAdmin={isOrgAdmin(token)}
      meetings={meetings}
      banner={trialBanner(trialEnds, Date.now())}
      notice={ended ? t(lang, 'meetingEndedByHost') : null}
      onDismissNotice={() => setEnded(false)}
      trial={trialStatus}
      error={err}
      onDismissError={() => setErr(null)}
      initialCode={pendingCode}
      onJoin={doJoin}
      onCreate={doCreate}
      onSetGuests={async (code, mode) => {
        await api.setGuests(token, code, mode);
        await refresh();
      }}
      onSignOut={() => void manager.signoutRedirect()}
      calendarToken={token}
      guestMax={guestMax}
      onboarding={onboarding}
      email={typeof user.profile.email === 'string' ? user.profile.email : ''}
      onTestDevices={() => markOnboarding({ devicesTested: true })}
      section={section}
      homeApi={homeApi}
      profileApi={profileApi}
      settingsApi={settingsApi}
      initialPasscode={pendingPwd}
      onCancelMeeting={async (code) => {
        await api.cancelMeeting(token, code);
        await refresh();
      }}
      sid={typeof user.profile.sid === 'string' ? user.profile.sid : undefined}
      avatarUrl={avatarUrl}
      onAvatarChange={setAvatarUrl}
      onSignedOutEverywhere={() => {
        void manager.removeUser().finally(() => location.assign('/app'));
      }}
      onSendVerification={async () => {
        await api.sendVerification(token);
      }}
      onDismissOnboarding={() => markOnboarding({ dismissed: true })}
    />
    </>
  );
}
