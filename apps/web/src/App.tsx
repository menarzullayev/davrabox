import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import type { User } from 'oidc-client-ts';
import { api, type GuestMode, type JoinedResult, type Meeting } from './api';
import { appErrorKey as errorKey } from './errors';
import { trialBanner } from './landing/trial';
import { consumeReturnPath, isAdminPath, rememberReturnPath } from './admin/helpers';
import { isOrgAdmin } from './admin/jwt';
import { currentUser, freshToken, manager, signIn } from './auth';
import { Call } from './Call';
import { detectLang, t, type Key, type Lang } from './i18n';
import { LoadingScreen, SignInScreen } from './home/AuthScreens';
import { HomeScreen } from './home/HomeScreen';
import type { NewMeetingData } from './home/NewMeetingDialog';
import { Waiting } from './home/Waiting';
import { createMeetingWithKey } from './e2ee/create';
import { takeKeyFromLocation } from './e2ee/keys';
import { applyTheme, readTheme, type ThemeChoice } from './ui';

// Loaded on demand so the home/call bundle does not grow for non-admins.
const AdminApp = lazy(() => import('./admin/AdminApp').then((m) => ({ default: m.AdminApp })));

const THEME_COLOR: Record<ThemeChoice, string> = { dark: '#0a0d21', light: '#f4f5fb' };

export function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const [theme, setThemeState] = useState<ThemeChoice>(readTheme);
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
  const [err, setErr] = useState<Key | null>(null);
  const [joined, setJoined] = useState<{ result: JoinedResult; code: string } | null>(null);
  const [waiting, setWaiting] = useState<{ code: string; requestId: string } | null>(null);
  // Guest (no account) state: a joined call or a waiting request with its own session token.
  const [guestJoined, setGuestJoined] = useState<{ result: JoinedResult; code: string } | null>(null);
  const [guestWaiting, setGuestWaiting] = useState<{ code: string; requestId: string; guestToken: string } | null>(null);
  const guestGetToken = useCallback(async () => guestJoined?.result.guestToken ?? '', [guestJoined]);
  const [guestMax, setGuestMax] = useState<GuestMode>('off');

  const [adminView, setAdminView] = useState(() => isAdminPath(location.pathname));

  useEffect(() => {
    currentUser()
      .then((u) => {
        // The Keycloak redirect always lands on "/": go back to the admin console if that is where the user was headed.
        if (u && consumeReturnPath()) {
          history.replaceState({}, document.title, '/admin');
          setAdminView(true);
        }
        setUser(u);
      })
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
    const onRenew = (u: User) => setUser(u);
    manager.events.addUserLoaded(onRenew);
    return () => manager.events.removeUserLoaded(onRenew);
  }, []);

  const token = user?.access_token ?? '';
  // Free-trial end date of the organization (null for a paid one); drives the "ends soon" notice on the home screen.
  const [trialEnds, setTrialEnds] = useState<string | null>(null);
  useEffect(() => {
    if (!token) return;
    api.trial(token).then((s) => setTrialEnds(s.trial ? s.endsAt : null)).catch(() => setTrialEnds(null));
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
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const changeLang = (l: Lang) => {
    setLang(l);
    document.documentElement.lang = l;
    try {
      localStorage.setItem('lang', l);
    } catch {
      /* ignore */
    }
  };

  const changeTheme = (v: ThemeChoice) => {
    setThemeState(v);
    applyTheme(v);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[v]);
  };

  const changeRelay = (v: boolean) => {
    setRelayMode(v);
    try {
      localStorage.setItem('relayMode', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const doJoin = async (c: string, p?: string) => {
    setErr(null);
    const clean = c.replace(/\s+/g, '');
    try {
      const res = await api.join(token, clean, p || undefined);
      try {
        sessionStorage.removeItem('pendingJoin');
      } catch {
        /* ignore */
      }
      setPendingCode('');
      if (res.status === 'joined') setJoined({ result: res, code: clean });
      else setWaiting({ code: clean, requestId: res.requestId });
    } catch (e) {
      setErr(errorKey(e));
    }
  };

  const doGuestJoin = async (rawCode: string, name: string, passcode?: string): Promise<void> => {
    const clean = rawCode.replace(/\s+/g, '');
    const res = await api.guestJoin(clean, name, passcode || undefined);
    try {
      sessionStorage.removeItem('pendingJoin');
    } catch {
      /* ignore */
    }
    setPendingCode('');
    if (res.status === 'joined') setGuestJoined({ result: res, code: clean });
    else setGuestWaiting({ code: clean, requestId: res.requestId, guestToken: res.guestToken });
  };

  const doCreate = async (d: NewMeetingData): Promise<Meeting> => {
    setErr(null);
    const m = await createMeetingWithKey((body) => api.create(token, body), d); // E2EE: the key is made here and never sent
    await refresh();
    return m;
  };

  // Plain language picker, kept for the admin console header (it receives it as a prop).
  const langPicker = (
    <select aria-label={t(lang, 'lang')} value={lang} onChange={(e) => changeLang(e.target.value as Lang)}>
      <option value="uz">O‘zbekcha</option>
      <option value="ru">Русский</option>
      <option value="en">English</option>
    </select>
  );

  if (loading) return <LoadingScreen lang={lang} />;

  if (guestJoined) {
    return <Call join={guestJoined.result} code={guestJoined.code} guest getToken={guestGetToken} lang={lang} onLeave={() => setGuestJoined(null)} />;
  }
  if (guestWaiting) {
    return (
      <Waiting
        lang={lang}
        code={guestWaiting.code}
        requestId={guestWaiting.requestId}
        guestToken={guestWaiting.guestToken}
        onAdmitted={(r) => {
          setGuestJoined({ result: r, code: guestWaiting.code });
          setGuestWaiting(null);
        }}
        onFailed={() => setGuestWaiting(null)}
        onCancel={() => setGuestWaiting(null)}
      />
    );
  }

  if (!user) {
    return (
      <SignInScreen
        lang={lang}
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
    );
  }

  if (adminView && !joined && !waiting) {
    return (
      <Suspense fallback={<main className="center">{t(lang, 'admLoading')}</main>}>
        <AdminApp lang={lang} langPicker={langPicker} user={user} onSignOut={() => void manager.signoutRedirect()} />
      </Suspense>
    );
  }

  if (joined) {
    return (
      <Call
        join={joined.result}
        code={joined.code}
        getToken={freshToken}
        lang={lang}
        onLeave={() => {
          setJoined(null);
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
          setJoined({ result: r, code: waiting.code });
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
      error={err}
      onDismissError={() => setErr(null)}
      initialCode={pendingCode}
      onJoin={doJoin}
      onCreate={doCreate}
      onSignOut={() => void manager.signoutRedirect()}
      calendarToken={token}
      guestMax={guestMax}
    />
  );
}
