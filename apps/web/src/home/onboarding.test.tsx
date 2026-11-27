// @vitest-environment jsdom
// The sign-up and onboarding package of 2026-11-27 on the client: the "Get started" card, the unverified-email reminder,
// the organisation set-up after a first Google/Microsoft sign-in, the device check mode of the pre-join screen, and the
// helpers that route them. The selectors used by apps/e2e/onboarding.e2e.mjs are asserted here too.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Meeting, type OnboardingView } from '../api';
import { dictionaries } from '../i18n';
import { needsOrganization } from '../admin/jwt';
import { sectionFromHash } from '../admin/AdminApp';
import { GetStarted, STEP_LINK, VerifyReminder } from './GetStarted';
import { HomeScreen, type HomeScreenProps } from './HomeScreen';
import { LAB_NOW, labMeetings } from './HomeLab';
import { OrgSetupScreen, setupErrorKey, suggestedOrg } from './OrgSetup';
import { PreJoin } from './PreJoin';

afterEach(cleanup);
const en = dictionaries.en;

const view = (over: Partial<OnboardingView> = {}): OnboardingView => ({
  steps: [
    { id: 'devices', done: false },
    { id: 'invite', done: true },
    { id: 'meeting', done: false },
    { id: 'guests', done: false },
    { id: 'email', done: false },
  ],
  dismissed: false,
  emailVerified: false,
  canSendVerification: true,
  ...over,
});

const jwt = (payload: object) => `h.${btoa(JSON.stringify(payload)).replace(/=+$/, '')}.s`;

describe('GetStarted card', () => {
  const setup = (v = view()) => {
    const p = { onTestDevices: vi.fn(), onNewMeeting: vi.fn(), onSendVerification: vi.fn(async () => undefined), onDismiss: vi.fn() };
    render(<GetStarted lang="en" view={v} {...p} />);
    return p;
  };

  it('lists the five steps in order with the progress, a progress bar and done steps without an action', () => {
    setup();
    const ids = [...document.querySelectorAll('[data-testid^="gs-step-"]')].map((e) => e.getAttribute('data-testid'));
    expect(ids).toEqual(['gs-step-devices', 'gs-step-invite', 'gs-step-meeting', 'gs-step-guests', 'gs-step-email']);
    expect(screen.getByTestId('gs-progress').textContent).toBe('1 of 5 done');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    expect(screen.getByTestId('gs-step-invite').hasAttribute('data-done')).toBe(true);
    expect(screen.queryByTestId('gs-action-invite')).toBeNull();
  });

  it('each open step has its real action', async () => {
    const p = setup();
    fireEvent.click(screen.getByTestId('gs-action-devices'));
    expect(p.onTestDevices).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('gs-action-meeting'));
    expect(p.onNewMeeting).toHaveBeenCalled();
    expect(screen.getByTestId('gs-action-guests').getAttribute('href')).toBe('/admin#policies');
    expect(STEP_LINK.invite).toBe('/admin#users');
    fireEvent.click(screen.getByTestId('gs-action-email'));
    await waitFor(() => expect(screen.getByTestId('gs-sent').textContent).toContain(en.obEmailSent));
    expect(p.onSendVerification).toHaveBeenCalledTimes(1);
  });

  it('a failed send says so (no false "sent")', async () => {
    const p = { onTestDevices: vi.fn(), onNewMeeting: vi.fn(), onSendVerification: vi.fn(async () => Promise.reject(new Error('503'))), onDismiss: vi.fn() };
    render(<GetStarted lang="en" view={view()} {...p} />);
    fireEvent.click(screen.getByTestId('gs-action-email'));
    await waitFor(() => expect(screen.getByTestId('gs-sent').textContent).toContain(en.obEmailFail));
  });

  it('without mail on the server the email step has no send button', () => {
    setup(view({ canSendVerification: false }));
    expect(screen.queryByTestId('gs-action-email')).toBeNull();
  });

  it('can be dismissed', () => {
    const p = setup();
    fireEvent.click(screen.getByTestId('gs-dismiss'));
    expect(p.onDismiss).toHaveBeenCalled();
  });

  it('is translated (uz, ru) without missing keys', () => {
    for (const lang of ['uz', 'ru'] as const) {
      cleanup();
      render(<GetStarted lang={lang} view={view()} onTestDevices={vi.fn()} onNewMeeting={vi.fn()} onSendVerification={vi.fn()} onDismiss={vi.fn()} />);
      expect(document.body.textContent).not.toMatch(/\bob[A-Z]\w+/);
      expect(screen.getByText(dictionaries[lang].obTitle)).toBeTruthy();
    }
  });
});

describe('home screen: card and reminder', () => {
  const base = (over: Partial<HomeScreenProps> = {}): HomeScreenProps => ({
    lang: 'en',
    onLang: vi.fn(),
    theme: 'dark',
    onTheme: vi.fn(),
    relayMode: false,
    onRelayMode: vi.fn(),
    profile: { name: 'Aziza Karimova' },
    isAdmin: true,
    meetings: labMeetings('few'),
    error: null,
    onDismissError: vi.fn(),
    initialCode: '',
    onJoin: vi.fn(async () => undefined),
    onCreate: vi.fn(async (d) => ({ id: 'n', code: '30011112222', title: d.title, waiting_room: true, locked: false, scheduled_at: null, has_passcode: false, is_host: true }) as Meeting),
    onSignOut: vi.fn(),
    now: LAB_NOW,
    email: 'aziza@acme.example',
    onSendVerification: vi.fn(async () => undefined),
    onDismissOnboarding: vi.fn(),
    onTestDevices: vi.fn(),
    ...over,
  });

  it('shows the card (not the reminder) while steps are open', () => {
    render(<HomeScreen {...base({ onboarding: view() })} />);
    expect(screen.getByTestId('get-started')).toBeTruthy();
    expect(screen.queryByTestId('verify-reminder')).toBeNull();
  });

  it('the "create a meeting" step opens the new-meeting dialog of the home screen', () => {
    render(<HomeScreen {...base({ onboarding: view() })} />);
    fireEvent.click(screen.getByTestId('gs-action-meeting'));
    expect(screen.getByTestId('meeting-title')).toBeTruthy();
  });

  it('after the card is closed, an unverified address still gets the reminder, which can be closed for this visit', async () => {
    const onSend = vi.fn(async () => undefined);
    render(<HomeScreen {...base({ onboarding: view({ dismissed: true }), onSendVerification: onSend })} />);
    expect(screen.queryByTestId('get-started')).toBeNull();
    const r = screen.getByTestId('verify-reminder');
    expect(r.textContent).toContain('aziza@acme.example');
    fireEvent.click(screen.getByTestId('verify-send'));
    await waitFor(() => expect(screen.getByTestId('verify-reminder').textContent).toContain(en.obEmailSentTo.replace('{email}', 'aziza@acme.example')));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('nothing at all when every step is done and the address is verified, or when the API gave no card', () => {
    const all = view({ emailVerified: true, steps: view().steps.map((s) => ({ ...s, done: true })) });
    render(<HomeScreen {...base({ onboarding: all })} />);
    expect(screen.queryByTestId('get-started')).toBeNull();
    expect(screen.queryByTestId('verify-reminder')).toBeNull();
    cleanup();
    render(<HomeScreen {...base({ onboarding: null })} />);
    expect(screen.queryByTestId('get-started')).toBeNull();
  });

  it('VerifyReminder: a failure is shown as a failure', async () => {
    render(<VerifyReminder lang="en" email="a@b.c" canSend onSend={async () => Promise.reject(new Error('x'))} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByTestId('verify-send'));
    await waitFor(() => expect(screen.getByTestId('verify-reminder').textContent).toContain(en.obEmailFail));
  });
});

describe('organisation set-up after a first Google/Microsoft sign-in', () => {
  it('needsOrganization: only a token without a valid organisation or without a DavraBox role', () => {
    expect(needsOrganization(jwt({ org_slug: 'acme', realm_access: { roles: ['member'] } }))).toBe(false);
    expect(needsOrganization(jwt({ realm_access: { roles: ['default-roles-davrabox'] } }))).toBe(true);
    expect(needsOrganization(jwt({ org_slug: 'acme', realm_access: { roles: [] } }))).toBe(true);
    expect(needsOrganization(jwt({ org_slug: 'BAD SLUG', realm_access: { roles: ['member'] } }))).toBe(true);
    expect(needsOrganization('')).toBe(false);
    expect(needsOrganization('not-a-jwt')).toBe(false);
  });

  it('suggests the organisation name from the person (or the mailbox) in the user language', () => {
    expect(suggestedOrg('uz', 'Ali Valiyev', 'a@b.c')).toBe('Ali Valiyev jamoasi');
    expect(suggestedOrg('en', '', 'dilnoza@acme.example')).toBe('dilnoza’s team');
  });

  it('creates with the suggested name in one click and shows refusals in plain words', async () => {
    const onCreate = vi.fn(async () => undefined);
    render(<OrgSetupScreen lang="en" onLang={vi.fn()} theme="dark" onTheme={vi.fn()} name="Ali Valiyev" email="ali@acme.example" onCreate={onCreate} onSignOut={vi.fn()} />);
    expect((screen.getByTestId('ob-org') as HTMLInputElement).value).toBe('Ali Valiyev’s team');
    expect(screen.getByText(en.obSetupText.replace('{email}', 'ali@acme.example'))).toBeTruthy();
    fireEvent.click(screen.getByTestId('ob-create'));
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Ali Valiyev’s team'));
  });

  it('a one-letter name is refused on the spot; a server refusal is shown and the form stays usable', async () => {
    const onCreate = vi.fn(async () => Promise.reject(new ApiError(409, 'x', 'email_taken')));
    render(<OrgSetupScreen lang="en" onLang={vi.fn()} theme="dark" onTheme={vi.fn()} name="Ali" email="ali@acme.example" onCreate={onCreate} onSignOut={vi.fn()} />);
    fireEvent.change(screen.getByTestId('ob-org'), { target: { value: 'A' } });
    fireEvent.click(screen.getByTestId('ob-create'));
    expect(screen.getByText(en.lnSuErrOrg)).toBeTruthy();
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('ob-org'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByTestId('ob-create'));
    expect(await screen.findByText(en.obErrEmailTaken)).toBeTruthy();
    expect((screen.getByTestId('ob-create') as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    [new ApiError(409, '', 'email_taken'), 'obErrEmailTaken'],
    [new ApiError(422, '', 'disposable_email'), 'lnSuErrDisposable'],
    [new ApiError(429, '', 'rate_limited'), 'lnSuErrRate'],
    [new ApiError(503, '', 'daily_cap'), 'lnSuErrCap'],
    [new ApiError(503, '', 'identity_unavailable'), 'lnSuErrUnavailable'],
    [new ApiError(403, '', 'not_external'), 'obErrNotAllowed'],
    [new TypeError('Failed to fetch'), 'lnSuErrUnavailable'],
    [new ApiError(500), 'lnSuErrGeneric'],
  ])('setupErrorKey(%s) -> %s', (e, key) => expect(setupErrorKey(e)).toBe(key));
});

describe('device check mode of the pre-join screen', () => {
  it('has its own title and "Done", and no "do not show again" choice', () => {
    render(<PreJoin lang="en" mode="test" title={en.obDeviceTestLead} onJoin={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(en.obDeviceTestTitle);
    expect(screen.getByTestId('prejoin-join').textContent).toBe(en.obDeviceTestDone);
    expect(screen.queryByTestId('prejoin-skip')).toBeNull();
    expect(screen.getByTestId('prejoin').getAttribute('data-mode')).toBe('test');
  });
});

describe('admin deep links', () => {
  it.each([
    ['#users', 'users'],
    ['#policies', 'policies'],
    ['', 'overview'],
    ['#nope', 'overview'],
    ['#assistant', 'overview'], // the platform-owner section is never opened from a link
  ])('%s -> %s', (hash, section) => expect(sectionFromHash(hash)).toBe(section));
});
