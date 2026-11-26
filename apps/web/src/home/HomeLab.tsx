// Development-only "home lab": renders the home, sign-in, waiting and loading screens with FAKE data so every state can
// be looked at and screenshotted without a backend or a sign-in. main.tsx only loads this module when
// import.meta.env.DEV or VITE_HOME_LAB=1 is set, so a normal production build contains neither this file nor its data.
//   /lab/home                      index of the states
//   /lab/home?screen=home&state=few|many|long|empty|loading|error|passcode&lang=uz|ru|en&theme=dark|light
//   /lab/home?screen=signin|waiting|loading|prejoin
import { useMemo, useState } from 'react';
import type { Meeting } from '../api';
import type { Key, Lang } from '../i18n';
import { isLang, isTheme, setPref, usePrefs, type ThemeChoice } from '../prefs';
import { LoadingScreen, SignInScreen, WaitingView } from './AuthScreens';
import { HomeScreen } from './HomeScreen';
import { PreJoin } from './PreJoin';

/** Fixed clock: Monday 23 November 2026, 14:20 local time. */
export const LAB_NOW = new Date(2026, 10, 23, 14, 20);

const at = (dayOffset: number, h: number, m: number) => new Date(2026, 10, 23 + dayOffset, h, m).toISOString();
let seq = 0;
function meeting(title: string, p: Partial<Meeting> = {}): Meeting {
  seq += 1;
  return {
    id: `lab-${seq}`,
    code: String(30000000000 + seq * 7919 * 1013).slice(0, 11),
    title,
    waiting_room: true,
    locked: false,
    scheduled_at: null,
    has_passcode: false,
    is_host: false,
    ...p,
  };
}

export function labMeetings(state: string): Meeting[] | null {
  seq = 0;
  switch (state) {
    case 'empty':
      return [];
    case 'loading':
      return null;
    case 'many':
      return [
        meeting('Ertalabki sinxron', { scheduled_at: at(0, 9, 30), is_host: true }),
        meeting('Dizayn tahlili', { scheduled_at: at(0, 11, 0) }),
        meeting('Haftalik yig‘ilish', { scheduled_at: at(0, 14, 0), is_host: true }),
        meeting('Mijozlar bilan uchrashuv', { scheduled_at: at(0, 15, 30), locked: true }),
        meeting('Loyiha taqdimoti', { scheduled_at: at(0, 16, 30), has_passcode: true }),
        meeting('Xavfsizlik auditi', { scheduled_at: at(0, 17, 15), has_passcode: true, is_host: true }),
        meeting('Retrospektiva', { scheduled_at: at(0, 18, 0) }),
        meeting('Oylik hisobot', { scheduled_at: at(1, 10, 0), is_host: true }),
        meeting('Yangi xodimlar bilan tanishuv', { scheduled_at: at(2, 12, 0) }),
        meeting('Qisqa rejalashtirish', { is_host: true }),
        meeting('Jamoa qahvasi'),
        meeting('Texnik suhbat', { has_passcode: true }),
        meeting('Kechagi yig‘ilish', { scheduled_at: at(-1, 10, 0) }),
        meeting('Byudjet muhokamasi', { scheduled_at: at(-2, 15, 0), has_passcode: true }),
      ];
    case 'long':
      return [
        meeting('Moliyaviy hisobotlar, byudjetni qayta ko‘rib chiqish va uchinchi chorak natijalari bo‘yicha rahbariyat bilan keng qamrovli muhokama', { scheduled_at: at(0, 14, 0), is_host: true, has_passcode: true }),
        meeting('Ежеквартальный обзор результатов отдела разработки, планирование релизов и распределение ресурсов между командами', { scheduled_at: at(0, 16, 0), locked: true }),
        meeting('Supercalifragilisticexpialidocious_integration_planning_session_with_the_infrastructure_team_2026', { scheduled_at: at(0, 18, 0) }),
        meeting('Quarterly business review with every regional office, including the long agenda that nobody can fit on one line', { has_passcode: true }),
      ];
    default:
      return [
        meeting('Haftalik yig‘ilish', { scheduled_at: at(0, 14, 0), is_host: true }),
        meeting('Loyiha taqdimoti', { scheduled_at: at(0, 16, 30), has_passcode: true }),
        meeting('Mijozlar bilan uchrashuv', { scheduled_at: at(0, 18, 0), locked: true }),
        meeting('Qisqa rejalashtirish', { is_host: true }),
        meeting('Ertalabki sinxron', { scheduled_at: at(0, 9, 30) }),
      ];
  }
}

const STATES = ['few', 'many', 'long', 'empty', 'loading', 'error', 'passcode'] as const;

function Index() {
  return (
    <main className="hm-center">
      <h1>Home lab (fake data)</h1>
      <ul>
        {['signin', 'waiting', 'loading', 'prejoin'].map((s) => (
          <li key={s}>
            <a href={`?screen=${s}`}>{s}</a>
          </li>
        ))}
        {STATES.map((s) => (
          <li key={s}>
            <a href={`?screen=home&state=${s}`}>home {s}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}

export default function HomeLab() {
  const q = useMemo(() => new URLSearchParams(location.search), []);
  const screen = q.get('screen');
  const state = q.get('state') ?? 'few';
  // A lab page takes language and theme from the URL for this visit only (nothing is saved).
  useMemo(() => {
    const l = q.get('lang');
    const th = q.get('theme');
    if (isLang(l)) setPref('lang', l, { persist: false });
    if (isTheme(th)) setPref('theme', th, { persist: false });
  }, [q]);
  const { lang, theme } = usePrefs();
  const [relay, setRelay] = useState(false);
  const [list, setList] = useState<Meeting[] | null>(() => labMeetings(state));
  const [error, setError] = useState<Key | null>(state === 'error' ? 'errWrongPasscode' : null);

  const changeLang = (l: Lang) => setPref('lang', l, { persist: false });
  const changeTheme = (v: ThemeChoice) => setPref('theme', v, { persist: false });

  if (screen === 'signin') return <SignInScreen lang={lang} onLang={changeLang} theme={theme} onTheme={changeTheme} onSignIn={() => undefined} />;
  if (screen === 'loading') return <LoadingScreen lang={lang} />;
  if (screen === 'prejoin') return <PreJoin lang={lang} title="Haftalik yig‘ilish" onJoin={() => undefined} onCancel={() => undefined} />;
  if (screen === 'waiting') return <WaitingView lang={lang} code="30812345678" onCancel={() => undefined} />;
  if (screen !== 'home') return <Index />;

  return (
    <HomeScreen
      lang={lang}
      onLang={changeLang}
      theme={theme}
      onTheme={changeTheme}
      relayMode={relay}
      onRelayMode={setRelay}
      profile={{ name: 'Alisher Narzullayev', email: 'alisher@example.test' }}
      isAdmin={state !== 'empty'}
      meetings={list}
      error={error}
      onDismissError={() => setError(null)}
      initialCode={state === 'passcode' ? '30812345678' : ''}
      onJoin={() => new Promise((r) => setTimeout(r, 500))}
      onCreate={async (d) => {
        const m = meeting(d.title, { is_host: true, has_passcode: Boolean(d.passcode), waiting_room: d.waitingRoom });
        setList((l) => [m, ...(l ?? [])]);
        return m;
      }}
      onSignOut={() => undefined}
      now={LAB_NOW}
    />
  );
}
