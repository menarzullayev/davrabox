import { useState, type FormEvent } from 'react';
import { t, type Key, type Lang } from '../i18n';
import { ApiError } from '../api';
import { Alert, Button, Logo, LogoMark, TextField, type ThemeChoice } from '../ui';
import { AppearanceControls } from './AppearanceControls';
import { tx } from './text';

export interface OrgSetupProps {
  lang: Lang;
  onLang: (l: Lang) => void;
  theme: ThemeChoice;
  onTheme: (v: ThemeChoice) => void;
  /** The person's name and address from the external provider. */
  name: string;
  email: string;
  /** Creates the organization (POST /v1/onboarding/organization). Rejects with ApiError. */
  onCreate: (orgName: string) => Promise<void>;
  onSignOut: () => void;
}

/** The organisation name offered by default: the same suggestion as on the sign-up form ("<name> jamoasi"). */
export function suggestedOrg(lang: Lang, name: string, email: string): string {
  const n = name.trim().replace(/\s+/g, ' ') || email.split('@')[0] || '';
  return n ? tx(lang, 'lnSuOrgSuggest', { name: n }).slice(0, 80) : '';
}

/** Maps the set-up refusals to the sign-up form's messages (same causes, same words). */
export function setupErrorKey(e: unknown): Key {
  if (!(e instanceof ApiError)) return 'lnSuErrUnavailable';
  if (e.status === 409 && e.code === 'email_taken') return 'obErrEmailTaken';
  if (e.status === 422) return 'lnSuErrDisposable';
  if (e.status === 429) return 'lnSuErrRate';
  if (e.status === 503 && e.code === 'daily_cap') return 'lnSuErrCap';
  if (e.status === 503) return 'lnSuErrUnavailable';
  if (e.status === 401 || e.status === 403) return 'obErrNotAllowed';
  return 'lnSuErrGeneric';
}

/**
 * First sign-in through Google or Microsoft (decision 4): the account exists but has no organisation yet. One field, already
 * filled with a suggestion, and one button; the organisation opens at once (decision 2) with the same 7-day trial.
 */
export function OrgSetupScreen({ lang, onLang, theme, onTheme, name, email, onCreate, onSignOut }: OrgSetupProps) {
  const [org, setOrg] = useState(() => suggestedOrg(lang, name, email));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Key | null>(null);
  const [fieldError, setFieldError] = useState<string | undefined>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const v = org.trim();
    if (v.length === 1) {
      setFieldError(tx(lang, 'lnSuErrOrg'));
      return;
    }
    setFieldError(undefined);
    setError(null);
    setBusy(true);
    try {
      await onCreate(v || suggestedOrg(lang, name, email));
    } catch (err) {
      setError(setupErrorKey(err));
      setBusy(false);
    }
  };

  return (
    <div className="si">
      <header className="si__bar">
        <span className="si__logo si__logo--full">
          <Logo height={26} title={t(lang, 'appName')} />
        </span>
        <span className="si__logo si__logo--mark">
          <LogoMark size={30} title={t(lang, 'appName')} />
        </span>
        <div className="si__tools">
          <AppearanceControls lang={lang} onLang={onLang} theme={theme} onTheme={onTheme} />
        </div>
      </header>
      <main className="si__main" data-testid="org-setup">
        <div className="si__copy">
          <section className="si__card" aria-labelledby="ob-setup-h">
            <h1 className="si__card-title" id="ob-setup-h">
              {tx(lang, 'obSetupTitle')}
            </h1>
            <p className="si__card-text">{tx(lang, 'obSetupText', { email })}</p>
            <form className="si__join" onSubmit={submit} noValidate>
              <TextField
                label={tx(lang, 'lnSuOrgName')}
                value={org}
                onChange={(e) => {
                  setOrg(e.target.value);
                  setFieldError(undefined);
                  setError(null);
                }}
                autoComplete="organization"
                maxLength={80}
                disabled={busy}
                error={fieldError}
                data-testid="ob-org"
              />
              <p className="si__hint">{tx(lang, 'obSetupTrial')}</p>
              {error ? <Alert tone="danger">{tx(lang, error)}</Alert> : null}
              <Button variant="primary" size="lg" fullWidth type="submit" loading={busy} data-testid="ob-create">
                {tx(lang, 'lnSuSubmit')}
              </Button>
              <Button variant="ghost" size="md" fullWidth onClick={onSignOut} disabled={busy} data-testid="ob-signout">
                {tx(lang, 'obSetupOther')}
              </Button>
            </form>
          </section>
        </div>
      </main>
    </div>
  );
}
