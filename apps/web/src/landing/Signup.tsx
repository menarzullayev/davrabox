import { useRef, useState, type FormEvent } from 'react';
import { tx } from '../home/text';
import { AppearanceControls } from '../home/AppearanceControls';
import type { Key } from '../i18n';
import { Alert, Button, Checkbox, Logo, Spinner, TextField } from '../ui';
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

export interface SignupDeps {
  /** POST to the public API (path below /api), resolves with status and parsed body. Rejects on a network failure. */
  post: (path: string, body?: unknown) => Promise<PostResult>;
  /** Proof-of-work solver. Rejects with SolveTimeoutError when it runs out of time. */
  solve: Solver;
  /** Starts the sign-in of the account that was just created (email prefilled). */
  signIn: (email: string) => void;
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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
type Phase = 'idle' | 'solving' | 'sending' | 'done';

/** Trial sign-up: four fields, a progress state while the proof of work runs, error states in three languages. */
export default function Signup({ deps = defaultDeps }: { deps?: SignupDeps }) {
  const { lang, setLang, theme, setTheme } = usePrefs('lnSuTitle');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<Key | null>(null);
  const [values, setValues] = useState({ org: '', name: '', email: '', password: '' });
  const [saved, setSaved] = useState(false);
  const busy = useRef(false);
  const set = (k: keyof typeof values) => (e: { target: { value: string } }) => {
    setValues((v) => ({ ...v, [k]: e.target.value }));
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    const v = { org: values.org.trim(), name: values.name.trim(), email: values.email.trim(), password: values.password };
    if (v.org.length < 2 || v.name.length < 1 || !EMAIL.test(v.email) || v.password.length < 12) {
      setError('lnSuErrInvalid');
      return;
    }
    if (!saved) {
      setError('lnSuErrSaved');
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
      const res = await deps.post('/v1/public/signup', { orgName: v.org, name: v.name, email: v.email, password: v.password, altcha });
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
        <section className="ln-su__card" aria-labelledby="ln-su-h">
          <h1 className="ln-su__title" id="ln-su-h">
            {tx(lang, 'lnSuTitle')}
          </h1>
          <p className="ln-su__lead">{tx(lang, 'lnSuLead')}</p>
          <form className="ln-su__form" onSubmit={submit} noValidate>
            <TextField label={tx(lang, 'lnSuOrgName')} value={values.org} onChange={set('org')} autoComplete="organization" maxLength={80} required disabled={working} />
            <TextField label={tx(lang, 'lnSuName')} value={values.name} onChange={set('name')} autoComplete="name" maxLength={80} required disabled={working} />
            <TextField label={tx(lang, 'lnSuEmail')} type="email" value={values.email} onChange={set('email')} autoComplete="email" inputMode="email" maxLength={254} required disabled={working} />
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
              hint={tx(lang, 'lnSuPasswordHint')}
            />
            <Checkbox label={tx(lang, 'lnSuSaved')} checked={saved} onChange={(e) => { setSaved(e.target.checked); setError(null); }} disabled={working} data-testid="su-saved" />
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
              <Button type="submit" variant="primary" size="lg" fullWidth loading={working} disabled={phase === 'done'}>
                {tx(lang, 'lnSuSubmit')}
              </Button>
            </div>
          </form>
          <p className="ln-su__foot">
            {tx(lang, 'lnSuHave')} <a href="/app">{tx(lang, 'lnSignIn')}</a> · <a href="/">{tx(lang, 'lnSuBack')}</a>
          </p>
        </section>
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
