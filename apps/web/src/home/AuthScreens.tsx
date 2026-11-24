import { LANGS } from '../prefs';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { t, type Lang } from '../i18n';
import { Button, ConnectingRing, Davra, IconChevronRight, Logo, LogoMark, TextField, type ThemeChoice } from '../ui';
import { extractKeyFromText, storeKey } from '../e2ee/keys';
import { appUrl } from '../routes';
import { appErrorKey } from '../errors';
import { LegalLinks } from '../privacy/LegalLinks';
import { SettingsMenu } from './SettingsMenu';
import { formatCode, parseJoinInput } from './logic';
import { tx } from './text';

/** Splits "A. B. C." into its sentences so the brand line can be set as a statement, one sentence per line. */
export const brandSentences = (line: string): string[] => line.split(/(?<=\.)\s+/).filter(Boolean);

export interface SignInScreenProps {
  lang: Lang;
  onLang: (l: Lang) => void;
  theme: ThemeChoice;
  onTheme: (v: ThemeChoice) => void;
  onSignIn: () => void;
  /** Remembers the meeting code (and an E2EE key from a pasted link), then starts the sign-in; the home screen joins after it. */
  onSignInToJoin?: (code: string) => void;
  /** Joins as a guest (no account): code, display name and an optional passcode. Rejects with the API error. */
  onGuestJoin?: (code: string, name: string, passcode?: string) => Promise<void>;
  /** A code from a meeting link (?join=): the field starts filled. */
  initialCode?: string;
}

/**
 * Calm sign-in in two steps, so the first screen always fits a phone without scrolling: step one has the brand statement,
 * the primary "Sign in", "Join with a meeting code" and "Create an organisation"; step two (code, name, passcode) opens in its
 * own view with a Back button. A meeting link (?join=) starts on step two with the code filled in.
 */
export function SignInScreen({ lang, onLang, theme, onTheme, onSignIn, onSignInToJoin, onGuestJoin, initialCode = '' }: SignInScreenProps) {
  const lines = brandSentences(tx(lang, 'hBrandLine'));
  const canJoin = Boolean(onSignInToJoin || onGuestJoin);
  const [view, setView] = useState<'start' | 'join'>(() => (initialCode && canJoin ? 'join' : 'start'));
  const [value, setValue] = useState(() => (initialCode ? formatCode(initialCode) : ''));
  const [touched, setTouched] = useState(false);
  const [guestName, setGuestName] = useState('');
  const [guestPass, setGuestPass] = useState('');
  const [guestErr, setGuestErr] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseJoinInput(value), [value]);
  const error =
    !touched || parsed.status === 'valid'
      ? undefined
      : parsed.status === 'invalid'
        ? tx(lang, parsed.reason === 'notCode' ? 'hJoinErrNotCode' : parsed.reason === 'tooLong' ? 'hJoinErrTooLong' : 'hJoinErrNoCode')
        : parsed.status === 'incomplete'
          ? tx(lang, 'hJoinErrShort')
          : tx(lang, 'hJoinErrEmpty');

  /** The validated code (and an E2EE key from a pasted link, kept in this tab), or null with the error shown. */
  const takeCode = (): string | null => {
    setTouched(true);
    if (parsed.status !== 'valid') return null;
    const key = extractKeyFromText(value);
    if (key) storeKey(parsed.code, key);
    return parsed.code;
  };
  const asGuest = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const code = takeCode();
    if (!code) return;
    if (!onGuestJoin) {
      onSignInToJoin?.(code);
      return;
    }
    const name = guestName.trim().replace(/\s+/g, ' ');
    if (name.length < 1 || name.length > 60) {
      setGuestErr(tx(lang, 'hGuestErrName'));
      return;
    }
    setGuestErr(undefined);
    setBusy(true);
    onGuestJoin(code, name, guestPass || undefined)
      .catch((err: unknown) => setGuestErr(t(lang, appErrorKey(err))))
      .finally(() => setBusy(false));
  };
  const withAccount = () => {
    const code = takeCode();
    if (code && onSignInToJoin) onSignInToJoin(code);
  };
  const leaveJoin = () => {
    setView('start');
    setGuestErr(undefined);
    setTouched(false);
  };
  // Opening the join step adds a history entry; Back (the Android button or the browser's) closes the step instead of the app.
  const openJoin = () => {
    try {
      history.pushState({ siJoin: true }, '');
    } catch {
      /* no history API: the Back button of the screen still works */
    }
    setView('join');
  };
  useEffect(() => {
    const onPop = () => {
      setView((v) => (v === 'join' ? 'start' : v));
      setGuestErr(undefined);
      setTouched(false);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const back = () => {
    if ((history.state as { siJoin?: boolean } | null)?.siJoin) history.back();
    else leaveJoin();
  };

  return (
    <div className="si" data-view={view}>
      <header className="si__bar">
        {/* The wordmark gives way to the mark alone on very narrow phones, where 48 px language buttons need the room. */}
        <span className="si__logo si__logo--full">
          <Logo height={26} title={t(lang, 'appName')} />
        </span>
        <span className="si__logo si__logo--mark">
          <LogoMark size={30} title={t(lang, 'appName')} />
        </span>
        <div className="si__tools">
          <div className="si__langs" role="group" aria-label={t(lang, 'privLangLabel')}>
            {LANGS.map((l) => (
              <button key={l.id} type="button" lang={l.id} title={l.name} aria-label={`${l.short}, ${l.name}`} aria-pressed={lang === l.id} onClick={() => onLang(l.id)}>
                {l.short}
              </button>
            ))}
          </div>
          <SettingsMenu lang={lang} onLang={onLang} theme={theme} onTheme={onTheme} />
        </div>
      </header>
      <main className="si__main" data-testid="signin">
        <div className="si__copy">
          <h1 className="si__statement">
            {lines.map((l, i) => (
              <span key={i} className="si__line" data-i={i}>
                {i > 0 ? ' ' : null}
                {l.endsWith('.') ? l.slice(0, -1) : l}
                {l.endsWith('.') ? <span className="si__stop">.</span> : null}
              </span>
            ))}
          </h1>
          {view === 'start' ? (
            <section className="si__card" aria-labelledby="si-card-h">
              <h2 className="si__card-title" id="si-card-h">
                {tx(lang, 'hSignInTitle')}
              </h2>
              <p className="si__card-text">{tx(lang, 'hSignInText')}</p>
              <Button className="primary" variant="primary" size="lg" fullWidth iconEnd={<IconChevronRight size={18} />} onClick={onSignIn}>
                {t(lang, 'signIn')}
              </Button>
              {canJoin ? (
                <Button variant="secondary" size="lg" fullWidth onClick={openJoin} data-testid="join-start">
                  {tx(lang, 'hJoinStartBtn')}
                </Button>
              ) : null}
              <a className="si__new" href={appUrl('signup')}>
                {tx(lang, 'hSignInNewOrg')}
              </a>
            </section>
          ) : (
            <section className="si__card" aria-labelledby="si-join-h" data-testid="signin-join-form-card">
              <h2 className="si__card-title" id="si-join-h">
                {tx(lang, 'hJoinTitle')}
              </h2>
              <form className="si__join" onSubmit={asGuest} noValidate data-testid="signin-join-form">
                <TextField
                  label={tx(lang, 'hJoinLabel')}
                  code
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={tx(lang, 'hJoinPlaceholder')}
                  value={value}
                  onChange={(e) => {
                    const v = e.target.value;
                    setValue(/^[\d\s.-]*$/.test(v) ? formatCode(v) : v);
                  }}
                  onBlur={() => setTouched(value.trim() !== '')}
                  error={error}
                />
                {onGuestJoin ? (
                  <>
                    <TextField
                      label={tx(lang, 'hGuestName')}
                      autoComplete="name"
                      maxLength={60}
                      data-testid="guest-name"
                      value={guestName}
                      onChange={(e) => setGuestName(e.target.value)}
                    />
                    <TextField label={tx(lang, 'hGuestPass')} type="password" autoComplete="off" maxLength={64} value={guestPass} onChange={(e) => setGuestPass(e.target.value)} />
                  </>
                ) : null}
                {guestErr ? <p className="si__err" role="alert">{guestErr}</p> : null}
                {onGuestJoin ? <p className="si__hint">{tx(lang, 'hGuestNote')}</p> : null}
                {onGuestJoin ? (
                  <Button variant="primary" size="lg" fullWidth type="submit" loading={busy} data-testid="guest-go">
                    {tx(lang, 'hGuestJoinBtn')}
                  </Button>
                ) : null}
                {onSignInToJoin ? (
                  <Button variant={onGuestJoin ? 'secondary' : 'primary'} size="lg" fullWidth type={onGuestJoin ? 'button' : 'submit'} onClick={onGuestJoin ? withAccount : undefined}>
                    {tx(lang, 'hSignInJoinBtn')}
                  </Button>
                ) : null}
                <Button variant="ghost" size="md" fullWidth onClick={back} data-testid="join-back">
                  {tx(lang, 'hJoinBack')}
                </Button>
              </form>
            </section>
          )}
        </div>
        {view === 'start' ? (
          <div className="si__art" aria-hidden="true">
            <Davra size={560} rings={4} petals={12} rotation={8} />
          </div>
        ) : null}
      </main>
      <LegalLinks lang={lang} />
    </div>
  );
}

/** Shown while the sign-in state is being resolved (the OIDC callback or a silent renewal). */
export function LoadingScreen({ lang }: { lang: Lang }) {
  return (
    <main className="hm-center" data-testid="loading">
      <h1 className="dx-sr-only">{t(lang, 'appName')}</h1>
      <ConnectingRing label={t(lang, 'signingIn')} size={112} />
    </main>
  );
}

export interface WaitingViewProps {
  lang: Lang;
  code: string;
  onCancel: () => void;
}

/** Waiting-room screen: the connecting ring with calm copy and a way out. Polling lives in <Waiting>. */
export function WaitingView({ lang, code, onCancel }: WaitingViewProps) {
  return (
    <main className="hm-center hm-wait" data-testid="waiting">
      <h1 className="hm-wait__title">{tx(lang, 'hWaitTitle')}</h1>
      <ConnectingRing label={tx(lang, 'hWaitStatus')} size={176} />
      <p className="hm-wait__text">{tx(lang, 'hWaitText')}</p>
      <p className="hm-wait__code">
        <span>{tx(lang, 'hWaitCode')}</span>
        <strong className="code dx-tabular">{formatCode(code)}</strong>
      </p>
      <Button variant="secondary" size="lg" onClick={onCancel}>
        {t(lang, 'cancel')}
      </Button>
    </main>
  );
}
