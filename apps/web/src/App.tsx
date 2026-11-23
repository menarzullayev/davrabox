import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from 'oidc-client-ts';
import { ApiError, api, type JoinedResult, type Meeting } from './api';
import { currentUser, manager } from './auth';
import { Call } from './Call';
import { detectLang, t, type Key, type Lang } from './i18n';

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

/** Fresh access token for long-lived screens (the library renews it silently). */
async function freshToken(): Promise<string> {
  const u = await manager.getUser();
  if (!u || u.expired) throw new Error('signed out');
  return u.access_token;
}

function Waiting({ lang, code, requestId, onAdmitted, onFailed, onCancel }: {
  lang: Lang;
  code: string;
  requestId: string;
  onAdmitted: (j: JoinedResult) => void;
  onFailed: (e: unknown) => void;
  onCancel: () => void;
}) {
  const done = useRef(false);
  useEffect(() => {
    done.current = false;
    const tick = async () => {
      if (done.current) return;
      try {
        const r = await api.requestStatus(await freshToken(), code, requestId);
        if (r.status === 'joined' && !done.current) {
          done.current = true;
          onAdmitted(r);
        }
      } catch (e) {
        if (e instanceof ApiError && !done.current) {
          done.current = true;
          onFailed(e);
        }
      }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => {
      done.current = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, requestId]);
  return (
    <main className="center" data-testid="waiting">
      <h1>{t(lang, 'waitingTitle')}</h1>
      <p className="muted">{t(lang, 'waitingHint')}</p>
      <button onClick={onCancel}>{t(lang, 'cancel')}</button>
    </main>
  );
}

export function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [title, setTitle] = useState('');
  const [newPass, setNewPass] = useState('');
  const [waitingRoom, setWaitingRoom] = useState(true);
  const [relayMode, setRelayMode] = useState(() => {
    try {
      return localStorage.getItem('relayMode') === '1';
    } catch {
      return false;
    }
  });
  const [code, setCode] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState<Key | null>(null);
  const [joined, setJoined] = useState<{ result: JoinedResult; code: string } | null>(null);
  const [waiting, setWaiting] = useState<{ code: string; requestId: string } | null>(null);

  useEffect(() => {
    currentUser()
      .then(setUser)
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
      setErr('errGeneric');
    }
  }, [token]);
  useEffect(() => {
    void refresh();
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

  const doJoin = async (c: string, p?: string) => {
    setErr(null);
    const clean = c.replace(/\s+/g, '');
    try {
      const res = await api.join(token, clean, p || undefined);
      if (res.status === 'joined') setJoined({ result: res, code: clean });
      else setWaiting({ code: clean, requestId: res.requestId });
    } catch (e) {
      setErr(errorKey(e));
    }
  };

  const doCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api.create(token, { title, passcode: newPass || undefined, waitingRoom });
      setTitle('');
      setNewPass('');
      await refresh();
    } catch {
      setErr('errGeneric');
    }
  };

  const langPicker = (
    <select aria-label={t(lang, 'lang')} value={lang} onChange={(e) => changeLang(e.target.value as Lang)}>
      <option value="uz">O‘zbekcha</option>
      <option value="ru">Русский</option>
      <option value="en">English</option>
    </select>
  );

  if (loading) return <main className="center">{t(lang, 'signingIn')}</main>;

  if (!user) {
    return (
      <main className="center">
        <h1>{t(lang, 'appName')}</h1>
        <button className="primary" onClick={() => manager.signinRedirect()}>{t(lang, 'signIn')}</button>
        {langPicker}
      </main>
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
    <main className="home">
      <header className="topbar">
        <h1>{t(lang, 'appName')}</h1>
        <span className="who">{user.profile.name ?? user.profile.email}</span>
        <label className="check" title={t(lang, 'relayHint')}>
          <input
            type="checkbox"
            checked={relayMode}
            data-testid="relay-mode"
            onChange={(e) => {
              setRelayMode(e.target.checked);
              try {
                localStorage.setItem('relayMode', e.target.checked ? '1' : '0');
              } catch {
                /* ignore */
              }
            }}
          />{' '}
          {t(lang, 'relayMode')}
        </label>
        {langPicker}
        <button onClick={() => manager.signoutRedirect()}>{t(lang, 'signOut')}</button>
      </header>
      {err && <div className="error" role="alert">{t(lang, err)}</div>}

      <section>
        <h2>{t(lang, 'newMeeting')}</h2>
        <form onSubmit={doCreate} className="row">
          <input required maxLength={200} placeholder={t(lang, 'title')} value={title} onChange={(e) => setTitle(e.target.value)} />
          <input type="password" minLength={6} maxLength={64} autoComplete="new-password" placeholder={t(lang, 'passcode')} value={newPass} onChange={(e) => setNewPass(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={waitingRoom} onChange={(e) => setWaitingRoom(e.target.checked)} data-testid="waiting-room" /> {t(lang, 'waitingRoom')}
          </label>
          <button className="primary" type="submit">{t(lang, 'create')}</button>
        </form>
      </section>

      <section>
        <h2>{t(lang, 'joinByCode')}</h2>
        <form onSubmit={(e) => { e.preventDefault(); void doJoin(code, pass); }} className="row">
          <input required inputMode="numeric" pattern="[0-9 ]{11,14}" placeholder={t(lang, 'code')} value={code} onChange={(e) => setCode(e.target.value)} />
          <input type="password" autoComplete="off" placeholder={t(lang, 'passcodeRequired')} value={pass} onChange={(e) => setPass(e.target.value)} />
          <button type="submit">{t(lang, 'join')}</button>
        </form>
      </section>

      <section>
        <h2>{t(lang, 'meetings')}</h2>
        {meetings.length === 0 && <p className="muted">{t(lang, 'noMeetings')}</p>}
        <ul className="list">
          {meetings.map((m) => (
            <li key={m.id}>
              <div>
                <strong>{m.title}</strong>
                <div className="muted code">{m.code.replace(/(\d{3})(\d{4})(\d+)/, '$1 $2 $3')}{m.has_passcode ? ' 🔒' : ''}</div>
              </div>
              <button className="primary" onClick={() => void (m.has_passcode && !m.is_host ? (setCode(m.code), undefined) : doJoin(m.code))}>{t(lang, 'join')}</button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
