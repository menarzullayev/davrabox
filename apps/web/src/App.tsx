import { useCallback, useEffect, useState } from 'react';
import type { User } from 'oidc-client-ts';
import { ApiError, api, type JoinResult, type Meeting } from './api';
import { currentUser, manager } from './auth';
import { Call } from './Call';
import { detectLang, t, type Key, type Lang } from './i18n';

function errorKey(e: unknown, passcodeSent: boolean): Key {
  if (e instanceof ApiError) {
    if (e.status === 404) return 'errNotFound';
    if (e.status === 429) return 'errTooMany';
    if (e.status === 403) return passcodeSent ? 'errWrongPasscode' : 'errLocked';
  }
  return 'errGeneric';
}

export function App() {
  const [lang, setLang] = useState<Lang>(detectLang);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [title, setTitle] = useState('');
  const [newPass, setNewPass] = useState('');
  const [code, setCode] = useState('');
  const [pass, setPass] = useState('');
  const [err, setErr] = useState<Key | null>(null);
  const [joined, setJoined] = useState<JoinResult | null>(null);

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
    try {
      setJoined(await api.join(token, c.replace(/\s+/g, ''), p || undefined));
    } catch (e) {
      setErr(errorKey(e, Boolean(p)));
    }
  };

  const doCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api.create(token, { title, passcode: newPass || undefined });
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
    return <Call join={joined} lang={lang} onLeave={() => { setJoined(null); void refresh(); }} />;
  }

  return (
    <main className="home">
      <header className="topbar">
        <h1>{t(lang, 'appName')}</h1>
        <span className="who">{user.profile.name ?? user.profile.email}</span>
        {langPicker}
        <button onClick={() => manager.signoutRedirect()}>{t(lang, 'signOut')}</button>
      </header>
      {err && <div className="error" role="alert">{t(lang, err)}</div>}

      <section>
        <h2>{t(lang, 'newMeeting')}</h2>
        <form onSubmit={doCreate} className="row">
          <input required maxLength={200} placeholder={t(lang, 'title')} value={title} onChange={(e) => setTitle(e.target.value)} />
          <input type="password" minLength={6} maxLength={64} autoComplete="new-password" placeholder={t(lang, 'passcode')} value={newPass} onChange={(e) => setNewPass(e.target.value)} />
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
              <button className="primary" onClick={() => void (m.has_passcode ? (setCode(m.code), undefined) : doJoin(m.code))}>{t(lang, 'join')}</button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
