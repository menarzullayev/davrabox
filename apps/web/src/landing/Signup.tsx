import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { tx } from '../home/text';
import { AppearanceControls } from '../home/AppearanceControls';
import type { Key, Lang } from '../i18n';
import { Alert, Button, IconBook, IconCheck, IconClock, IconGlobe, IconLock, IconShieldCheck, IconUsers, Logo, Spinner, TextField } from '../ui';
import { solveInWorker, solveWithTimeout, SolveTimeoutError, type AltchaChallenge, type Solver } from './altcha';
import { usePrefs } from './usePrefs';
import './landing.css';

export interface PostResult {
  status: number;
  body: unknown;
}

const codeOf = (body: unknown): string | undefined => {
  const c = (body as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
};

/** External sign-in providers the realm may offer (decision 4 of 2026-11-27). */
export type SocialProvider = 'google' | 'microsoft';

export interface SignupDeps {
  /** POST to the public API (path below /api), resolves with status and parsed body. Rejects on a network failure. */
  post: (path: string, body?: unknown) => Promise<PostResult>;
  /** Proof-of-work solver. Rejects with SolveTimeoutError when it runs out of time. */
  solve: Solver;
  /** Starts the sign-in of the account that was just created (email prefilled). */
  signIn: (email: string) => void;
  /** Which "Continue with ..." buttons to show; resolves to [] when none is configured or the API cannot say. */
  providers?: () => Promise<SocialProvider[]>;
  /** Starts the sign-in through an external provider (Keycloak's kc_idp_hint). */
  social?: (provider: SocialProvider, lang: Lang) => void;
}

const defaultDeps: SignupDeps = {
  post: async (path, body) => {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  },
  solve: solveInWorker,
  // The authorization-code flow needs the OIDC client; it is loaded only now, so the form itself stays light.
  signIn: (email) => void import('../auth').then((m) => m.signIn({ loginHint: email })),
  providers: async () => {
    try {
      const res = await fetch('/api/v1/public/signin-options');
      if (!res.ok) return [];
      const list = ((await res.json()) as { providers?: unknown }).providers;
      return Array.isArray(list) ? list.filter((p): p is SocialProvider => p === 'google' || p === 'microsoft') : [];
    } catch {
      return [];
    }
  },
  social: (provider, lang) => void import('../auth').then((m) => m.signIn({ idpHint: provider, lang })),
};

/** Maps an API answer (status and stable `code`) to the message shown to the user. */
export function signupErrorKey(status: number, code?: string): Key {
  if (status === 400 && code === 'invalid_input') return 'lnSuErrInvalid';
  if (status === 400 && code?.startsWith('captcha_')) return 'lnSuErrCaptcha';
  if (status === 409) return 'lnSuErrTaken';
  if (status === 422 && code === 'disposable_email') return 'lnSuErrDisposable';
  if (status === 422) return 'lnSuErrRejected';
  if (status === 429) return 'lnSuErrRate';
  if (status === 503 && code === 'daily_cap') return 'lnSuErrCap';
  if (status === 503) return 'lnSuErrUnavailable';
  return 'lnSuErrGeneric';
}

/** The organisation name offered when the field is left empty (decision 3): "<name> jamoasi" / "Команда <name>" / "<name>'s team". */
export function suggestOrgName(lang: Lang, name: string): string {
  const n = name.trim().replace(/\s+/g, ' ');
  if (!n) return '';
  return tx(lang, 'lnSuOrgSuggest', { name: n }).slice(0, 80);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
type Phase = 'idle' | 'solving' | 'sending' | 'done';
type FieldErrors = Partial<Record<'name' | 'email' | 'password' | 'org', Key>>;

/** Real features only (decision 6): what the trial gives, shown next to the form (under it on phones). */
const VALUE: Array<{ icon: ReactNode; key: Key }> = [
  { icon: <IconClock size={20} />, key: 'lnSuV1' },
  { icon: <IconCheck size={20} />, key: 'lnSuV2' },
  { icon: <IconUsers size={20} />, key: 'lnSuV3' },
  { icon: <IconLock size={20} />, key: 'lnSuV4' },
  { icon: <IconShieldCheck size={20} />, key: 'lnSuV5' },
  { icon: <IconBook size={20} />, key: 'lnSuV6' },
  { icon: <IconGlobe size={20} />, key: 'lnSuV7' },
];

/** Trial sign-up: one page, name / email / password and an optional organisation name, plus Google and Microsoft. */
export default function Signup({ deps = defaultDeps }: { deps?: SignupDeps }) {
  const { lang, setLang, theme, setTheme } = usePrefs('lnSuTitle');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<Key | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [values, setValues] = useState({ org: '', name: '', email: '', password: '' });
  const [providers, setProviders] = useState<SocialProvider[]>([]);
  const busy = useRef(false);

  useEffect(() => {
    let live = true;
    void (deps.providers ?? (async () => []))().then((p) => live && setProviders(p));
    return () => {
      live = false;
    };
  }, [deps]);

  const set = (k: keyof typeof values) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [k]: e.target.value }));
    setError(null);
    setFieldErrors((f) => ({ ...f, [k]: undefined }));
  };
  const suggestion = suggestOrgName(lang, values.name);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    const v = { org: values.org.trim(), name: values.name.trim(), email: values.email.trim(), password: values.password };
    // Rules are shown only when they are broken (decision 3), next to the field that broke them.
    const errs: FieldErrors = {};
    if (v.name.length < 1) errs.name = 'lnSuErrName';
    if (!EMAIL.test(v.email)) errs.email = 'lnSuErrEmail';
    if (v.password.length < 12) errs.password = 'lnSuPasswordRule';
    else if (v.password.toLowerCase() === v.email.toLowerCase()) errs.password = 'lnSuPasswordNotEmail';
    if (v.org.length === 1) errs.org = 'lnSuErrOrg';
    setFieldErrors(errs);
    if (Object.keys(errs).length) {
      setError(null);
      return;
    }
    busy.current = true;
    setError(null);
    try {
      setPhase('solving');
      const challenge = await deps.post('/v1/public/challenge');
      if (challenge.status !== 200) throw new HttpFailure(challenge.status, codeOf(challenge.body));
      const altcha = await solveWithTimeout(challenge.body as AltchaChallenge, deps.solve);
      setPhase('sending');
      const orgName = v.org || suggestOrgName(lang, v.name);
      const res = await deps.post('/v1/public/signup', { orgName, name: v.name, email: v.email, password: v.password, altcha, lang });
      if (res.status !== 201) throw new HttpFailure(res.status, codeOf(res.body));
      setPhase('done');
      deps.signIn(v.email);
    } catch (err) {
      setPhase('idle');
      setError(err instanceof HttpFailure ? signupErrorKey(err.status, err.code) : err instanceof SolveTimeoutError ? 'lnSuErrSolve' : 'lnSuErrUnavailable');
    } finally {
      busy.current = false;
    }
  };

  const working = phase === 'solving' || phase === 'sending' || phase === 'done';
  const fe = (k: keyof FieldErrors) => (fieldErrors[k] ? tx(lang, fieldErrors[k]!) : undefined);
  return (
    <div className="ln-page ln-su">
      <header className="ln-header">
        <div className="ln-header__in">
          <a className="ln-brand" href="/" aria-label="DavraBox">
            <Logo height={30} />
          </a>
          <span className="ln-spacer" />
          <AppearanceControls lang={lang} onLang={setLang} theme={theme} onTheme={setTheme} />
        </div>
      </header>
      <main className="ln-su__main" id="ln-main">
        <div className="ln-su__grid">
          <section className="ln-su__card" aria-labelledby="ln-su-h">
            <h1 className="ln-su__title" id="ln-su-h">
              {tx(lang, 'lnSuTitle')}
            </h1>
            <p className="ln-su__lead">{tx(lang, 'lnSuLead')}</p>
            {providers.length ? (
              <div className="ln-su__social" data-testid="su-social">
                {providers.map((p) => (
                  <Button
                    key={p}
                    variant="secondary"
                    size="lg"
                    fullWidth
                    disabled={working}
                    data-testid={`su-social-${p}`}
                    icon={<img src={p === 'google' ? '/brand/google-g.svg' : '/brand/microsoft.svg'} alt="" width={20} height={20} />}
                    onClick={() => (deps.social ?? defaultDeps.social!)(p, lang)}
                  >
                    {tx(lang, p === 'google' ? 'lnSuGoogle' : 'lnSuMicrosoft')}
                  </Button>
                ))}
                <p className="ln-su__or" aria-hidden="true">
                  <span>{tx(lang, 'lnSuOr')}</span>
                </p>
              </div>
            ) : null}
            <form className="ln-su__form" onSubmit={submit} noValidate>
              <TextField label={tx(lang, 'lnSuName')} value={values.name} onChange={set('name')} autoComplete="name" maxLength={80} required disabled={working} error={fe('name')} data-testid="su-name" />
              <TextField
                label={tx(lang, 'lnSuEmail')}
                type="email"
                value={values.email}
                onChange={set('email')}
                autoComplete="email"
                inputMode="email"
                maxLength={254}
                required
                disabled={working}
                error={fe('email')}
                data-testid="su-email"
              />
              <TextField
                label={tx(lang, 'lnSuPassword')}
                type="password"
                value={values.password}
                onChange={set('password')}
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
                disabled={working}
                error={fe('password')}
                data-testid="su-password"
              />
              <TextField
                label={tx(lang, 'lnSuOrgName')}
                optionalText={tx(lang, 'lnSuOptional')}
                value={values.org}
                onChange={set('org')}
                autoComplete="organization"
                maxLength={80}
                placeholder={suggestion || undefined}
                hint={suggestion && !values.org.trim() ? tx(lang, 'lnSuOrgHint', { name: suggestion }) : undefined}
                disabled={working}
                error={fe('org')}
                data-testid="su-org"
              />
              <div className="ln-su__actions">
                {error ? (
                  <Alert tone="danger">
                    {tx(lang, error)}
                    {error === 'lnSuErrTaken' ? (
                      <>
                        {' '}
                        <a href="/app">{tx(lang, 'lnSignIn')}</a>
                      </>
                    ) : null}
                  </Alert>
                ) : null}
                <p className="ln-su__status" role="status">
                  {phase === 'solving' ? (
                    <>
                      <Spinner size={16} />
                      {tx(lang, 'lnSuSolving')}
                    </>
                  ) : phase === 'sending' ? (
                    <>
                      <Spinner size={16} />
                      {tx(lang, 'lnSuCreating')}
                    </>
                  ) : phase === 'done' ? (
                    tx(lang, 'lnSuDone')
                  ) : null}
                </p>
                <Button type="submit" variant="primary" size="lg" fullWidth loading={working} disabled={phase === 'done'} data-testid="su-submit">
                  {tx(lang, 'lnSuSubmit')}
                </Button>
              </div>
            </form>
            <p className="ln-su__foot">
              {tx(lang, 'lnSuHave')} <a href="/app">{tx(lang, 'lnSignIn')}</a> · <a href="/">{tx(lang, 'lnSuBack')}</a>
            </p>
          </section>
          <aside className="ln-su__card ln-su__value" aria-labelledby="ln-su-value-h" data-testid="su-value">
            <h2 className="ln-su__value-title" id="ln-su-value-h">
              {tx(lang, 'lnSuValueTitle')}
            </h2>
            <ul className="ln-su__value-list">
              {VALUE.map((v) => (
                <li key={v.key}>
                  <span className="ln-su__value-icon">{v.icon}</span>
                  <span>{tx(lang, v.key)}</span>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      </main>
    </div>
  );
}

class HttpFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(`http ${status}`);
  }
}
