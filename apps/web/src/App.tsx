import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import type { User } from 'oidc-client-ts';
import { ApiError, api, type JoinedResult, type Meeting } from './api';
import { consumeReturnPath, isAdminPath, rememberReturnPath } from './admin/helpers';
import { isOrgAdmin } from './admin/jwt';
import { currentUser, freshToken, manager } from './auth';
import { Call } from './Call';
import { detectLang, t, type Key, type Lang } from './i18n';
import { LoadingScreen, SignInScreen } from './home/AuthScreens';
import { HomeScreen } from './home/HomeScreen';
import type { NewMeetingData } from './home/NewMeetingDialog';
import { Waiting } from './home/Waiting';
import { applyTheme, readTheme, type ThemeChoice } from './ui';

// Loaded on demand so the home/call bundle does not grow for non-admins.
const AdminApp = lazy(() => import('./admin/AdminApp').then((m) => ({ default: m.AdminApp })));

function errorKey(e: unknown): Key {
  if (e instanceof ApiError) {
    if (e.status === 404) return 'errNotFound';
    if (e.status === 429) return 'errTooMany';
    if (e.status === 403) {
      if (/passcode/i.test(e.detail)) return 'errWrongPasscode';
      if (/locked/i.test(e.detail)) return 'errLocked';
      if (/removed/i.test(e.detail)) return 'errRemoved';
      if (/declined/i.test(e.detail)) return 'errDenied';
    }
  }
  return 'errGeneric';
}

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

  const doCreate = async (d: NewMeetingData): Promise<Meeting> => {
    setErr(null);
    const m = await api.create(token, { title: d.title, passcode: d.passcode, waitingRoom: d.waitingRoom });
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

  if (!user) {
    return (
      <SignInScreen
        lang={lang}
        onLang={changeLang}
        theme={theme}
        onTheme={changeTheme}
        onSignIn={() => {
          rememberReturnPath(location.pathname);
          void manager.signinRedirect();
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
      error={err}
      onDismissError={() => setErr(null)}
      initialCode={pendingCode}
      onJoin={doJoin}
      onCreate={doCreate}
      onSignOut={() => void manager.signoutRedirect()}
    />
  );
}
