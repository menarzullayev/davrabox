import { useMemo, useState, type FormEvent } from 'react';
import { t, type Lang } from '../i18n';
import { Button, ConnectingRing, Davra, IconChevronRight, Logo, TextField, type ThemeChoice } from '../ui';
import { extractKeyFromText, storeKey } from '../e2ee/keys';
import { appUrl } from '../routes';
import { LegalLinks } from '../privacy/LegalLinks';
import { SettingsMenu } from './SettingsMenu';
import { formatCode, parseJoinInput } from './logic';
import { tx } from './text';

const LANG_BUTTONS: Array<{ id: Lang; short: string; name: string }> = [
  { id: 'uz', short: 'UZ', name: 'O‘zbekcha' },
  { id: 'ru', short: 'RU', name: 'Русский' },
  { id: 'en', short: 'EN', name: 'English' },
];

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
}

/** Calm sign-in: the brand statement, the davra ornament behind it and one clear primary action. */
export function SignInScreen({ lang, onLang, theme, onTheme, onSignIn, onSignInToJoin }: SignInScreenProps) {
  const lines = brandSentences(tx(lang, 'hBrandLine'));
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const parsed = useMemo(() => parseJoinInput(value), [value]);
  const error =
    !touched || parsed.status === 'valid'
      ? undefined
      : parsed.status === 'invalid'
        ? tx(lang, parsed.reason === 'notCode' ? 'hJoinErrNotCode' : parsed.reason === 'tooLong' ? 'hJoinErrTooLong' : 'hJoinErrNoCode')
        : parsed.status === 'incomplete'
          ? tx(lang, 'hJoinErrShort')
          : tx(lang, 'hJoinErrEmpty');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (parsed.status !== 'valid' || !onSignInToJoin) return;
    const key = extractKeyFromText(value);
    if (key) storeKey(parsed.code, key);
    onSignInToJoin(parsed.code);
  };
  return (
    <div className="si">
      <header className="si__bar">
        <Logo height={30} title={t(lang, 'appName')} />
        <div className="si__tools">
          <div className="si__langs" role="group" aria-label={t(lang, 'appName')}>
            {LANG_BUTTONS.map((l) => (
              <button key={l.id} type="button" lang={l.id} title={l.name} aria-label={l.name} aria-pressed={lang === l.id} onClick={() => onLang(l.id)}>
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
          <section className="si__card" aria-labelledby="si-card-h">
            <h2 className="si__card-title" id="si-card-h">
              {tx(lang, 'hSignInTitle')}
            </h2>
            <p className="si__card-text">{tx(lang, 'hSignInText')}</p>
            <Button className="primary" variant="primary" size="lg" fullWidth iconEnd={<IconChevronRight size={18} />} onClick={onSignIn}>
              {t(lang, 'signIn')}
            </Button>
            {onSignInToJoin ? (
              <form className="si__join" onSubmit={submit} noValidate data-testid="signin-join-form">
                <p className="si__or">{tx(lang, 'hSignInOr')}</p>
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
                  hint={tx(lang, 'hSignInJoinNote')}
                />
                <Button variant="secondary" size="lg" fullWidth type="submit">
                  {tx(lang, 'hSignInJoinBtn')}
                </Button>
              </form>
            ) : null}
            <a className="si__new" href={appUrl('signup')}>
              {tx(lang, 'hSignInNewOrg')}
            </a>
          </section>
        </div>
        <div className="si__art" aria-hidden="true">
          <Davra size={560} rings={4} petals={12} rotation={8} />
        </div>
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
