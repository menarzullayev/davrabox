// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dictionaries } from '../i18n';
import { SolveTimeoutError, type AltchaChallenge } from './altcha';
import Signup, { signupErrorKey, type SignupDeps } from './Signup';

const CH: AltchaChallenge = { algorithm: 'SHA-256', challenge: 'c'.repeat(64), salt: 's?expires=1', signature: 'f'.repeat(64), maxnumber: 10 };
const en = dictionaries.en;

function setup(over: Partial<SignupDeps> = {}) {
  const post = vi.fn(async (path: string) => (path.endsWith('challenge') ? { status: 200, body: CH } : { status: 201, body: { slug: 'acme', signInUrl: '/app' } }));
  const solve = vi.fn(async () => 'payload');
  const signIn = vi.fn();
  localStorage.setItem('lang', 'en');
  render(<Signup deps={{ post, solve, signIn, ...over }} />);
  return { post, solve, signIn };
}

function fill(values: Partial<Record<'org' | 'name' | 'email' | 'password', string>> = {}, saved = true) {
  const v = { org: 'Acme Corp', name: 'Aziza Karimova', email: 'aziza@acme.example', password: 'correct-horse-battery', ...values };
  fireEvent.change(screen.getByLabelText(en.lnSuOrgName), { target: { value: v.org } });
  fireEvent.change(screen.getByLabelText(en.lnSuName), { target: { value: v.name } });
  fireEvent.change(screen.getByLabelText(en.lnSuEmail), { target: { value: v.email } });
  fireEvent.change(screen.getByLabelText(new RegExp(`^${en.lnSuPassword}`)), { target: { value: v.password } });
  if (saved) fireEvent.click(screen.getByTestId('su-saved'));
}
const submit = () => fireEvent.submit(screen.getByRole('button', { name: en.lnSuSubmit }).closest('form')!);

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('password care on the sign-up form', () => {
  it('refuses to create the organisation until the person confirms the password is saved, and posts nothing', async () => {
    const { post } = setup();
    fill({}, false);
    submit();
    expect(await screen.findByText(en.lnSuErrSaved)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('su-saved'));
    expect(screen.queryByText(en.lnSuErrSaved)).toBeNull();
  });

  it('the eye button shows and hides the typed password and says which it will do', () => {
    setup();
    const input = screen.getByLabelText(new RegExp(`^${en.lnSuPassword}`)) as HTMLInputElement;
    const eye = screen.getByTestId('password-eye');
    expect(input.type).toBe('password');
    expect(eye.getAttribute('aria-label')).toBe('Show password');
    fireEvent.click(eye);
    expect(input.type).toBe('text');
    expect(eye.getAttribute('aria-label')).toBe('Hide password');
    expect(eye.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(eye);
    expect(input.type).toBe('password');
  });
});

describe('signupErrorKey', () => {
  it.each([
    [400, 'invalid_input', 'lnSuErrInvalid'],
    [400, 'captcha_invalid', 'lnSuErrCaptcha'],
    [400, 'captcha_expired', 'lnSuErrCaptcha'],
    [400, 'captcha_replayed', 'lnSuErrCaptcha'],
    [409, 'email_taken', 'lnSuErrTaken'],
    [422, 'disposable_email', 'lnSuErrDisposable'],
    [422, 'identity_rejected', 'lnSuErrRejected'],
    [429, 'rate_limited', 'lnSuErrRate'],
    [503, 'daily_cap', 'lnSuErrCap'],
    [503, 'identity_unavailable', 'lnSuErrUnavailable'],
    [503, 'busy', 'lnSuErrUnavailable'],
    [503, 'signup_unavailable', 'lnSuErrUnavailable'],
    [500, undefined, 'lnSuErrGeneric'],
    [418, 'whatever', 'lnSuErrGeneric'],
  ])('%s %s -> %s', (status, code, key) => expect(signupErrorKey(status, code)).toBe(key));
});

describe('sign-up page', () => {
  it('has four labelled fields, one h1, a submit button and a way back', () => {
    setup();
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(screen.getByLabelText(en.lnSuOrgName)).toBeTruthy();
    expect(screen.getByLabelText(en.lnSuName)).toBeTruthy();
    expect(screen.getByLabelText(en.lnSuEmail)).toBeTruthy();
    expect(screen.getByLabelText(new RegExp(`^${en.lnSuPassword}`))).toBeTruthy();
    expect(screen.getByRole('button', { name: en.lnSuSubmit })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: en.lnSignIn }).every((a) => a.getAttribute('href') === '/app')).toBe(true);
    expect((screen.getByLabelText(en.lnSuEmail) as HTMLInputElement).type).toBe('email');
    expect((screen.getByLabelText(new RegExp(`^${en.lnSuPassword}`)) as HTMLInputElement).autocomplete).toBe('new-password');
  });

  it('solves the challenge, posts the form with the solution and then goes to sign-in with the email prefilled', async () => {
    const { post, solve, signIn } = setup();
    fill();
    submit();
    await waitFor(() => expect(signIn).toHaveBeenCalledWith('aziza@acme.example'));
    expect(solve).toHaveBeenCalledWith(CH, expect.anything());
    expect(post).toHaveBeenNthCalledWith(1, '/v1/public/challenge');
    expect(post).toHaveBeenNthCalledWith(2, '/v1/public/signup', { orgName: 'Acme Corp', name: 'Aziza Karimova', email: 'aziza@acme.example', password: 'correct-horse-battery', altcha: 'payload' });
    expect(screen.getByText(en.lnSuDone)).toBeTruthy();
  });

  it('does not call the server for a password shorter than 12 characters, a missing field or a bad email', () => {
    const { post } = setup();
    fill({ password: 'short-11-ch' });
    submit();
    expect(screen.getByRole('alert').textContent).toContain(en.lnSuErrInvalid);
    fill({ org: '' });
    submit();
    fill({ email: 'not-an-email' });
    submit();
    expect(post).not.toHaveBeenCalled();
  });

  it('shows the friendly "already registered" message with a sign-in link, and lets the user try again', async () => {
    const { signIn } = setup({
      post: vi.fn(async (path: string) => (path.endsWith('challenge') ? { status: 200, body: CH } : { status: 409, body: { code: 'email_taken' } })),
    });
    fill();
    submit();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(en.lnSuErrTaken);
    expect(screen.getAllByRole('link', { name: en.lnSignIn }).length).toBeGreaterThan(0);
    expect(signIn).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: en.lnSuSubmit }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the message for each refusal class in the user language', async () => {
    for (const [status, code, key] of [[422, 'disposable_email', 'lnSuErrDisposable'], [429, 'rate_limited', 'lnSuErrRate'], [503, 'daily_cap', 'lnSuErrCap'], [503, 'identity_unavailable', 'lnSuErrUnavailable']] as const) {
      cleanup();
      setup({ post: vi.fn(async (p: string) => (p.endsWith('challenge') ? { status: 200, body: CH } : { status: status, body: { code } })) });
      fill();
      submit();
      expect((await screen.findByRole('alert')).textContent).toContain(en[key]);
    }
  });

  it('a solver that runs out of time shows the time-out message and the form stays usable', async () => {
    const { post } = setup({ solve: vi.fn(async () => { throw new SolveTimeoutError(); }) });
    fill();
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain(en.lnSuErrSolve);
    expect(post).toHaveBeenCalledTimes(1); // only the challenge was requested
    expect((screen.getByRole('button', { name: en.lnSuSubmit }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a network failure is reported as unavailable, not as a crash', async () => {
    setup({ post: vi.fn(async () => { throw new TypeError('Failed to fetch'); }) });
    fill();
    submit();
    expect((await screen.findByRole('alert')).textContent).toContain(en.lnSuErrUnavailable);
  });

  it('shows progress while the proof of work runs and ignores a second submit', async () => {
    let release: (v: string) => void = () => undefined;
    const solve = vi.fn(() => new Promise<string>((r) => { release = r; }));
    const { post } = setup({ solve });
    fill();
    submit();
    await waitFor(() => expect(screen.getByText(en.lnSuSolving)).toBeTruthy());
    submit();
    submit();
    expect(solve).toHaveBeenCalledTimes(1);
    release('payload');
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
  });

  it('renders in Uzbek and Russian without untranslated keys', () => {
    for (const lang of ['uz', 'ru'] as const) {
      cleanup();
      localStorage.setItem('lang', lang);
      render(<Signup deps={{ post: vi.fn(), solve: vi.fn(), signIn: vi.fn() }} />);
      expect(document.body.textContent).not.toMatch(/\bln[A-Z]\w+/);
      expect(screen.getByLabelText(dictionaries[lang].lnSuOrgName)).toBeTruthy();
    }
  });
});
