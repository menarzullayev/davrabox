// @vitest-environment jsdom
// Component tests of the home, sign-in and waiting screens. The "e2e selector compatibility" block lists every
// selector apps/e2e/*.e2e.mjs uses on these screens and proves the components still render them (the real e2e needs
// the full stack and runs after merging).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meeting } from '../api';
import { dictionaries, type Lang } from '../i18n';
import { SignInScreen, WaitingView, brandSentences } from './AuthScreens';
import { HomeScreen, type HomeScreenProps } from './HomeScreen';
import { LAB_NOW, labMeetings } from './HomeLab';
import { pickOption } from '../ui/testing';

afterEach(cleanup);

const raf = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function props(over: Partial<HomeScreenProps> = {}): HomeScreenProps {
  return {
    lang: 'en',
    onLang: vi.fn(),
    theme: 'dark',
    onTheme: vi.fn(),
    relayMode: false,
    onRelayMode: vi.fn(),
    profile: { name: 'Alisher Narzullayev' },
    isAdmin: false,
    meetings: labMeetings('few'),
    error: null,
    onDismissError: vi.fn(),
    initialCode: '',
    onJoin: vi.fn(async () => undefined),
    onCreate: vi.fn(async (d) => ({ id: 'new', code: '30011112222', title: d.title, waiting_room: d.waitingRoom, locked: false, scheduled_at: null, has_passcode: Boolean(d.passcode), is_host: true }) as Meeting),
    onSignOut: vi.fn(),
    now: LAB_NOW,
    ...over,
  };
}

const openTab = (name: RegExp | string) => fireEvent.click(screen.getByRole('tab', { name }));
const joinForm = () => document.querySelector<HTMLFormElement>('[data-testid=join-form]')!;
const codeInput = () => joinForm().querySelector<HTMLInputElement>('input[inputmode=numeric]')!;

describe('created label on rows without a schedule', () => {
  const row = (title: string, created_at: string | undefined, scheduled_at: string | null = null): Meeting => ({
    id: title, code: '30000000001', title, waiting_room: true, locked: false, scheduled_at, created_at, has_passcode: false,
  });
  it('shows "Created just now", a time today and a date earlier; scheduled rows have none', () => {
    const meetings = [
      row('Fresh', new Date(LAB_NOW.getTime() - 20_000).toISOString()),
      row('Today', new Date(2026, 10, 23, 9, 5).toISOString()),
      row('Old', new Date(2026, 10, 20, 15, 24).toISOString()),
      row('Planned', new Date(2026, 10, 23, 9, 5).toISOString(), new Date(2026, 10, 24, 10, 0).toISOString()),
      row('Legacy', undefined),
    ];
    render(<HomeScreen {...props({ meetings })} />);
    const label = (t: string) => screen.getByText(t).closest('li')!.querySelector('[data-testid=row-created]')?.textContent;
    expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/^Ongoing/);
    expect(label('Fresh')).toBe('Created just now');
    expect(label('Today')).toBe('Created 09:05');
    expect(label('Old')).toBe('Created 20 November, 15:24');
    expect(label('Legacy')).toBeUndefined();
    openTab(/^Upcoming/);
    expect(label('Planned')).toBeUndefined();
  });
});

describe('meeting tabs', () => {
  const tabNames = () => screen.getAllByRole('tab').map((t) => t.textContent);
  it('has Ongoing / Upcoming / Ended with counts and opens the first one that has meetings', () => {
    render(<HomeScreen {...props({ meetings: labMeetings('many') })} />);
    expect(tabNames()).toEqual(['Ongoing4', 'Upcoming6', 'Ended4']);
    expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/^Ongoing/);
  });
  it('opens Upcoming when nothing is ongoing and Ended when only past meetings exist', () => {
    const past = { id: 'p', code: '30000000009', title: 'Past', waiting_room: true, locked: false, scheduled_at: new Date(2026, 10, 20, 10, 0).toISOString(), has_passcode: false } as Meeting;
    const soon = { ...past, id: 's', title: 'Soon', scheduled_at: new Date(2026, 10, 23, 18, 0).toISOString() };
    const { rerender } = render(<HomeScreen {...props({ meetings: [soon, past] })} />);
    expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/^Upcoming/);
    rerender(<HomeScreen {...props({ meetings: [past] })} />);
    expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/^Ended/);
  });
  it('shows a message in an empty tab and keeps the chosen tab when the list refreshes', () => {
    const past = { id: 'p', code: '30000000009', title: 'Past', waiting_room: true, locked: false, scheduled_at: new Date(2026, 10, 20, 10, 0).toISOString(), has_passcode: false } as Meeting;
    const { rerender } = render(<HomeScreen {...props({ meetings: [past] })} />);
    openTab(/^Upcoming/);
    expect(screen.getByTestId('tab-empty-upcoming').textContent).toBe('No upcoming meetings.');
    rerender(<HomeScreen {...props({ meetings: [past, { ...past, id: 'q', title: 'Past 2' }] })} />);
    expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/^Upcoming/);
  });
  it('moves between tabs with the arrow keys and is translated', () => {
    const { rerender } = render(<HomeScreen {...props({ meetings: labMeetings('many') })} />);
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/^Upcoming/);
    rerender(<HomeScreen {...props({ lang: 'uz', meetings: labMeetings('many') })} />);
    expect(tabNames()).toEqual(['Davom etayotgan4', 'Kutilayotgan6', 'Tugagan4']);
    rerender(<HomeScreen {...props({ lang: 'ru', meetings: labMeetings('many') })} />);
    expect(tabNames()).toEqual(['Идущие4', 'Предстоящие6', 'Завершённые4']);
  });
});

describe('Plan & Limits panel', () => {
  const trial = (over = {}) => ({ trial: true, expired: false, endsAt: new Date(LAB_NOW.getTime() + 4 * 86_400_000).toISOString(), maxParticipants: 10, maxMinutes: 30, ...over });
  it('shows days left and the trial limits for a trial organization', () => {
    render(<HomeScreen {...props({ trial: trial() })} />);
    const panel = screen.getByTestId('plan-panel');
    expect(within(panel).getByRole('heading', { level: 2 }).textContent).toBe('Plan & Limits');
    expect(within(panel).getByText('Free trial')).toBeTruthy();
    expect(within(screen.getByTestId('plan-days')).getByText('4')).toBeTruthy();
    expect(within(screen.getByTestId('plan-participants')).getByText('10')).toBeTruthy();
    expect(within(screen.getByTestId('plan-minutes')).getByText('30 min')).toBeTruthy();
  });
  it('comes after the meeting list', () => {
    render(<HomeScreen {...props({ trial: trial() })} />);
    const list = screen.getByRole('region', { name: 'Meetings' });
    expect(list.compareDocumentPosition(screen.getByTestId('plan-panel')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
  it('says the trial ended and omits limits the API did not send', () => {
    render(<HomeScreen {...props({ trial: trial({ endsAt: new Date(LAB_NOW.getTime() - 1000).toISOString(), expired: true, maxMinutes: null }) })} />);
    expect(within(screen.getByTestId('plan-panel')).getByText('Trial ended')).toBeTruthy();
    expect(screen.queryByTestId('plan-minutes')).toBeNull();
  });
  it('is absent for a paid organization and while the status is unknown', () => {
    const { rerender } = render(<HomeScreen {...props({ trial: { trial: false, expired: false, endsAt: null, maxParticipants: null, maxMinutes: null } })} />);
    expect(screen.queryByTestId('plan-panel')).toBeNull();
    rerender(<HomeScreen {...props({ trial: null })} />);
    expect(screen.queryByTestId('plan-panel')).toBeNull();
  });
  it('speaks Uzbek and Russian too', () => {
    const { rerender } = render(<HomeScreen {...props({ lang: 'uz', trial: trial() })} />);
    expect(within(screen.getByTestId('plan-panel')).getByRole('heading').textContent).toBe('Reja va cheklovlar');
    expect(within(screen.getByTestId('plan-participants')).getByText('10')).toBeTruthy();
    rerender(<HomeScreen {...props({ lang: 'ru', trial: trial() })} />);
    expect(within(screen.getByTestId('plan-minutes')).getByText('30 мин')).toBeTruthy();
  });
});

describe('HomeScreen content', () => {
  it('greets by first name and groups meetings now / later / recent / earlier', () => {
    render(<HomeScreen {...props()} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Good afternoon, Alisher');
    expect(screen.getByText('Monday, 23 November')).toBeTruthy();
    const groups = () => screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent!.replace(/\d+$/, ''));
    expect(groups()).toEqual(['Now', 'Recent meetings']);
    openTab(/^Upcoming/);
    expect(groups()).toEqual(['Later today']);
    openTab(/^Ended/);
    expect(groups()).toEqual(['Earlier']);
  });

  it('shows the passcode, locked and host markers on a row', () => {
    render(<HomeScreen {...props()} />);
    openTab(/^Upcoming/);
    const locked = screen.getByText('Client meeting'.replace('Client meeting', 'Mijozlar bilan uchrashuv')).closest('li')!;
    expect(within(locked).getByText('Locked')).toBeTruthy();
    const pass = screen.getByText('Loyiha taqdimoti').closest('li')!;
    expect(within(pass).getByText('Passcode')).toBeTruthy();
    openTab(/^Ongoing/);
    const host = screen.getByText('Haftalik yig‘ilish').closest('li')!;
    expect(within(host).getByText('You host')).toBeTruthy();
    expect(within(host).getByText('In progress')).toBeTruthy();
  });

  it('shows skeletons while loading and the empty state without meetings', () => {
    const { rerender } = render(<HomeScreen {...props({ meetings: null })} />);
    expect(screen.getByRole('status', { name: 'Loading meetings…' }).getAttribute('aria-busy')).toBe('true');
    rerender(<HomeScreen {...props({ meetings: [] })} />);
    expect(screen.getByText('No meetings yet')).toBeTruthy();
    expect(screen.getByTestId('new-meeting-empty')).toBeTruthy();
  });

  it('shows the admin link only for admins', () => {
    const { rerender } = render(<HomeScreen {...props()} />);
    expect(screen.queryByTestId('admin-link')).toBeNull();
    rerender(<HomeScreen {...props({ isAdmin: true })} />);
    expect(screen.getByTestId('admin-link').getAttribute('href')).toBe('/admin');
    // The label is its own element: the phone layout hides it and leaves the icon.
    expect(screen.getByRole('link', { name: 'Admin' }).querySelector('.hm-admin__label')).toBeTruthy();
  });

  it('survives 40% longer text: a very long title stays in its row and keeps its full text for assistive technology', () => {
    render(<HomeScreen {...props({ meetings: labMeetings('long') })} />);
    const rows: Element[] = [];
    for (const name of [/^Ongoing/, /^Upcoming/, /^Ended/]) {
      openTab(name);
      rows.push(...document.querySelectorAll('li.hm-row'));
    }
    expect(rows).toHaveLength(4);
    expect(rows.some((r) => r.querySelector('.hm-row__title')!.getAttribute('title')!.length > 100)).toBe(true);
  });

  it('copies the join link of a row', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<HomeScreen {...props()} />);
    const row = screen.getByText('Haftalik yig‘ilish').closest('li')!;
    fireEvent.click(within(row).getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const link = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(link).toMatch(/\/app\?join=\d{11}$/);
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Link copied' })).toBeTruthy());
  });
});

describe('join by code or link', () => {
  it('validates as you type and turns a pasted link into its code', () => {
    render(<HomeScreen {...props()} />);
    fireEvent.change(codeInput(), { target: { value: '123 4567' } });
    expect(screen.getByText('4 more digits needed')).toBeTruthy();
    fireEvent.change(codeInput(), { target: { value: 'https://davrabox.example.test/?join=30812345678' } });
    expect(codeInput().value).toBe('308 1234 5678');
    expect(screen.getByText('Code taken from the link: 308 1234 5678')).toBeTruthy();
    fireEvent.change(codeInput(), { target: { value: '30812345678' } });
    expect(screen.getByText('Code looks right: 308 1234 5678')).toBeTruthy();
  });

  it('flags clearly wrong input at once and an incomplete code on submit', () => {
    const onJoin = vi.fn(async () => undefined);
    render(<HomeScreen {...props({ onJoin })} />);
    fireEvent.change(codeInput(), { target: { value: 'abc' } });
    expect(screen.getAllByText('A code contains digits only').length).toBeGreaterThan(0);
    expect(codeInput().getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(codeInput(), { target: { value: '12345' } });
    expect(screen.queryByText('A code has at least 11 digits')).toBeNull();
    fireEvent.submit(joinForm());
    expect(screen.getAllByText('A code has at least 11 digits').length).toBeGreaterThan(0);
    expect(onJoin).not.toHaveBeenCalled();
  });

  it('submits the clean code with the passcode and does not double-submit while busy', async () => {
    let finish: () => void = () => undefined;
    const onJoin = vi.fn(() => new Promise<void>((r) => (finish = r)));
    render(<HomeScreen {...props({ onJoin })} />);
    fireEvent.change(codeInput(), { target: { value: '308 1234 5678' } });
    fireEvent.click(screen.getByTestId('join-passcode-toggle'));
    fireEvent.change(joinForm().querySelector('input[type=password]')!, { target: { value: 'secret-1' } });
    fireEvent.submit(joinForm());
    fireEvent.submit(joinForm());
    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onJoin).toHaveBeenCalledWith('30812345678', 'secret-1');
    await act(async () => finish());
  });

  it('prefills a pending code (?join= / sessionStorage)', () => {
    render(<HomeScreen {...props({ initialCode: '30812345678' })} />);
    expect(codeInput().value).toBe('308 1234 5678');
  });

  it('a protected meeting row hands over to the passcode field; an open one joins directly', async () => {
    const onJoin = vi.fn(async () => undefined);
    render(<HomeScreen {...props({ onJoin })} />);
    openTab(/^Upcoming/);
    const protectedRow = screen.getByText('Loyiha taqdimoti').closest('li')!;
    fireEvent.click(within(protectedRow).getByRole('button', { name: /Join: Loyiha taqdimoti/ }));
    expect(onJoin).not.toHaveBeenCalled();
    expect(codeInput().value).toMatch(/^\d{3} \d{4} \d+$/);
    await act(raf);
    expect(document.activeElement).toBe(joinForm().querySelector('input[type=password]'));
    expect(screen.getByText('This meeting is protected by a passcode. Enter it to continue.')).toBeTruthy();
    openTab(/^Ongoing/);
    const openRow = screen.getByText('Haftalik yig‘ilish').closest('li')!;
    await act(async () => {
      fireEvent.click(within(openRow).getByRole('button', { name: /Join: Haftalik/ }));
    });
    expect(onJoin).toHaveBeenCalledTimes(1);
  });
});

describe('new meeting dialog', () => {
  it('collects title, passcode and the waiting-room switch and creates the meeting', async () => {
    const onCreate = vi.fn(props().onCreate);
    render(<HomeScreen {...props({ onCreate })} />);
    fireEvent.click(screen.getByTestId('new-meeting'));
    const dlg = await screen.findByRole('dialog', { name: 'New meeting' });
    fireEvent.change(within(dlg).getByTestId('meeting-title'), { target: { value: 'Planning' } });
    fireEvent.change(dlg.querySelector('input[type=password]')!, { target: { value: 'abcdef1' } });
    fireEvent.click(within(dlg).getByTestId('waiting-room'));
    fireEvent.submit(dlg.querySelector('form')!);
    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ title: 'Planning', passcode: 'abcdef1', waitingRoom: false, e2ee: false }));
    await waitFor(() => expect(screen.getByText('Meeting created')).toBeTruthy());
  });

  it('shows an error inside the dialog when creating fails and keeps the form', async () => {
    render(<HomeScreen {...props({ onCreate: vi.fn(async () => Promise.reject(new Error('x'))) })} />);
    fireEvent.click(screen.getByTestId('new-meeting'));
    const dlg = await screen.findByRole('dialog', { name: 'New meeting' });
    fireEvent.change(within(dlg).getByTestId('meeting-title'), { target: { value: 'Planning' } });
    fireEvent.submit(dlg.querySelector('form')!);
    await waitFor(() => expect(within(dlg).getByRole('alert').textContent).toBe(dictionaries.en.errGeneric));
    expect((within(dlg).getByTestId('meeting-title') as HTMLInputElement).value).toBe('Planning');
  });
});

describe('liquid-glass phone tab bar (present in every style, shown only by that style)', () => {
  it('New opens the new-meeting dialog, Settings opens the settings panel, Join focuses the code field', async () => {
    render(<HomeScreen {...props()} />);
    const bar = screen.getByRole('navigation', { name: 'Sections' });
    fireEvent.click(within(bar).getByTestId('tab-new'));
    expect(await screen.findByRole('dialog', { name: 'New meeting' })).toBeTruthy();
    fireEvent.click(within(bar).getByTestId('tab-settings'));
    expect(within(bar).getByTestId('tab-settings').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(within(bar).getByTestId('tab-join'));
    expect(document.activeElement?.closest('.hm-join')).toBeTruthy();
  });
  it('keeps the shared test ids unique (the header settings button is still the only "settings")', () => {
    render(<HomeScreen {...props()} />);
    expect(screen.getAllByTestId('settings')).toHaveLength(1);
    expect(screen.getAllByTestId('new-meeting')).toHaveLength(1);
  });
});

describe('settings menu', () => {
  it('holds language, appearance and the firewall mode, and reports changes', async () => {
    const p = props();
    render(<HomeScreen {...p} />);
    expect(screen.queryByTestId('relay-mode')).toBeNull();
    fireEvent.click(screen.getByTestId('settings'));
    const panel = await screen.findByRole('dialog', { name: 'Settings' });
    pickOption(within(panel).getByLabelText('Language'), 'ru');
    expect(p.onLang).toHaveBeenCalledWith('ru');
    fireEvent.click(within(panel).getByRole('radio', { name: 'Light' }));
    expect(p.onTheme).toHaveBeenCalledWith('light');
    expect((within(panel).getByRole('radio', { name: 'Dark' }) as HTMLElement).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(within(panel).getByTestId('relay-mode'));
    expect(p.onRelayMode).toHaveBeenCalledWith(true);
  });

  it('Escape closes it and returns focus to the trigger', async () => {
    render(<HomeScreen {...props()} />);
    const trigger = screen.getByTestId('settings');
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Settings' });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('sign-in and waiting screens', () => {
  it('sign-in has exactly one primary action and the brand line in the heading', () => {
    const onSignIn = vi.fn();
    render(<SignInScreen lang="uz" onLang={vi.fn()} theme="dark" onTheme={vi.fn()} onSignIn={onSignIn} />);
    fireEvent.click(screen.getByRole('button', { name: 'Kirish' }));
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Xavfsiz. Oddiy. Sizning nazoratingizda.');
  });

  it('splits the brand line into sentences in every language', () => {
    for (const lang of ['uz', 'ru', 'en'] as Lang[]) expect(brandSentences(dictionaries[lang].hBrandLine)).toHaveLength(3);
  });

  it('waiting view announces the status, shows the code and lets the user cancel', () => {
    const onCancel = vi.fn();
    render(<WaitingView lang="en" code="30812345678" onCancel={onCancel} />);
    expect(screen.getByTestId('waiting')).toBeTruthy();
    // critic P-07: the headline comes before the status line
    const head = screen.getByRole('heading', { level: 1 });
    expect(head.compareDocumentPosition(screen.getByRole('status')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Waiting for permission');
    expect(screen.getByText('308 1234 5678')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe('error banner', () => {
  it('announces a join error with role=alert and can be dismissed', () => {
    const p = props({ error: 'errWrongPasscode' });
    render(<HomeScreen {...p} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(dictionaries.en.errWrongPasscode);
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss message' }));
    expect(p.onDismissError).toHaveBeenCalled();
  });
  it('renders no alert when there is no error (e2e waits for [role=alert] to appear)', () => {
    render(<HomeScreen {...props()} />);
    expect(document.querySelectorAll('[role=alert]')).toHaveLength(0);
  });
});

// ---- e2e compatibility ---------------------------------------------------------------------------------------------
// Selectors used by apps/e2e/*.e2e.mjs on the home / sign-in / waiting screens (after the documented edits):
describe.each(['uz', 'ru', 'en'] as Lang[])('e2e selector compatibility (%s)', (lang) => {
  beforeEach(() => {
    cleanup();
  });
  it('home: .home, join form, create dialog, row .code, relay switch', async () => {
    render(<HomeScreen {...props({ lang, meetings: [...(labMeetings('few') ?? []), { id: 'e2e', code: '30099998888', title: 'e2e-title-123', waiting_room: true, locked: false, scheduled_at: null, has_passcode: false, is_host: true }] })} />);
    // waitForSelector('.home') and `.home` count === 1
    expect(document.querySelectorAll('.home')).toHaveLength(1);
    // form[data-testid=join-form]: one numeric input, exactly one button; the password input appears once the
    // "I have a passcode" checkbox (data-testid=join-passcode-toggle) is ticked (critic D-13)
    expect(document.querySelectorAll('[data-testid=join-form]')).toHaveLength(1);
    expect(joinForm().querySelectorAll('input[inputmode=numeric]')).toHaveLength(1);
    expect(joinForm().querySelectorAll('input[type=password]')).toHaveLength(0);
    expect(within(joinForm()).getAllByRole('button')).toHaveLength(1);
    fireEvent.click(within(joinForm()).getByTestId('join-passcode-toggle'));
    expect(joinForm().querySelectorAll('input[type=password]')).toHaveLength(1);
    expect(within(joinForm()).getAllByRole('button')).toHaveLength(1);
    // li:has-text(title) .code -> digits of the code only
    const li = [...document.querySelectorAll('li')].filter((x) => x.textContent!.toLowerCase().includes('e2e-title-123'));
    expect(li).toHaveLength(1);
    expect(li[0]!.querySelectorAll('.code')).toHaveLength(1);
    expect(li[0]!.querySelector('.code')!.textContent!.replace(/\D/g, '')).toBe('30099998888');
    // settings -> [data-testid=relay-mode] (a checkbox: Playwright check()/uncheck())
    fireEvent.click(screen.getByTestId('settings'));
    const relay = await screen.findByTestId('relay-mode');
    expect((relay as HTMLInputElement).type).toBe('checkbox');
    cleanup();
    // new meeting dialog: [data-testid=meeting-title], input[type=password][minlength], [data-testid=waiting-room],
    // and exactly one button named /Create|Yaratish|Создать/ in the whole page, also while the "Get started" card shows
    const allOpen = { steps: (['devices', 'invite', 'meeting', 'guests', 'email'] as const).map((id) => ({ id, done: false })), dismissed: false, emailVerified: false, canSendVerification: true };
    render(<HomeScreen {...props({ lang, isAdmin: true, onboarding: allOpen, email: 'e2e@example.org' })} />);
    expect(screen.getByTestId('get-started')).toBeTruthy();
    fireEvent.click(screen.getByTestId('new-meeting'));
    await screen.findByTestId('meeting-title');
    expect(document.querySelectorAll('input[type=password][minlength]')).toHaveLength(1);
    expect((screen.getByTestId('waiting-room') as HTMLInputElement).type).toBe('checkbox');
    expect((screen.getByTestId('waiting-room') as HTMLInputElement).checked).toBe(true);
    const createButtons = screen.getAllByRole('button', { name: /Create|Yaratish|Создать/ });
    expect(createButtons).toHaveLength(1);
    expect(createButtons[0]!.getAttribute('type')).toBe('submit');
    // nothing else on the page may match the create regex (strict mode)
    expect([...document.querySelectorAll('button')].filter((b) => /Create|Yaratish|Создать/.test(b.textContent ?? '')).length).toBe(1);
  });

  it('sign-in: exactly one button named /Sign in|Kirish|Войти/ with class primary; sign out is a button on home', () => {
    render(<SignInScreen lang={lang} onLang={vi.fn()} theme="dark" onTheme={vi.fn()} onSignIn={vi.fn()} />);
    const b = screen.getAllByRole('button', { name: /Sign in|Kirish|Войти/ });
    expect(b).toHaveLength(1);
    expect(b[0]!.classList.contains('primary')).toBe(true);
    cleanup();
    render(<HomeScreen {...props({ lang })} />);
    expect(screen.getAllByRole('button', { name: /Sign out|Chiqish|Выйти/ })).toHaveLength(1);
  });

  it('waiting: [data-testid=waiting]', () => {
    render(<WaitingView lang={lang} code="30812345678" onCancel={vi.fn()} />);
    expect(document.querySelectorAll('[data-testid=waiting]')).toHaveLength(1);
  });
});

describe('join card passcode (critic D-13)', () => {
  const passField = () => joinForm().querySelector<HTMLInputElement>('input[type=password]');

  it('hides the passcode field until the user asks for it, then moves focus into it', async () => {
    render(<HomeScreen {...props()} />);
    expect(passField()).toBeNull();
    const toggle = screen.getByTestId('join-passcode-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await act(raf);
    expect(passField()).not.toBeNull();
    expect(document.activeElement).toBe(passField());
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(passField()).toBeNull();
  });

  it('shows the field when the server answered that a passcode is required or wrong', () => {
    render(<HomeScreen {...props({ error: 'errWrongPasscode' })} />);
    expect(passField()).not.toBeNull();
  });

  it('keeps the keyboard flow: code, passcode checkbox, Join; after ticking it: code, checkbox, passcode, Join', async () => {
    const user = userEvent.setup();
    render(<HomeScreen {...props()} />);
    codeInput().focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('join-passcode-toggle'));
    await user.tab();
    expect(document.activeElement).toBe(joinForm().querySelector('button[type=submit]'));
    screen.getByTestId('join-passcode-toggle').focus();
    await user.keyboard(' ');
    await act(raf);
    expect(document.activeElement).toBe(passField());
    codeInput().focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('join-passcode-toggle'));
    await user.tab();
    expect(document.activeElement).toBe(passField());
    await user.tab();
    expect(document.activeElement).toBe(joinForm().querySelector('button[type=submit]'));
  });

  it('joins without a passcode when none was asked for', async () => {
    const onJoin = vi.fn(async () => undefined);
    render(<HomeScreen {...props({ onJoin })} />);
    fireEvent.change(codeInput(), { target: { value: '308 1234 5678' } });
    await act(async () => {
      fireEvent.submit(joinForm());
    });
    expect(onJoin).toHaveBeenCalledWith('30812345678', undefined);
  });
});

describe('changing a meeting\'s guests from the home screen', () => {
  it('a host row opens the guest setting and saves it within the organization limit', async () => {
    const onSetGuests = vi.fn(async () => undefined);
    const meetings = labMeetings('few')!.map((m) => ({ ...m, is_host: true, guest_mode: 'off' as const }));
    render(<HomeScreen {...props({ meetings, guestMax: 'waiting_room', onSetGuests })} />);
    const buttons = screen.getAllByTestId('guests-row');
    expect(buttons.length).toBeGreaterThan(0); // one per hosted row in the open tab
    fireEvent.click(buttons[0]!);
    pickOption('guests-edit', 'waiting_room');
    fireEvent.click(screen.getByTestId('guests-save'));
    await waitFor(() => expect(onSetGuests).toHaveBeenCalledWith(expect.stringMatching(/^\d{11,12}$/), 'waiting_room'));
  });

  it('shows no guests button when the organization allows no guests or for rows the person does not host', () => {
    const own = labMeetings('few')!.map((m) => ({ ...m, is_host: true }));
    render(<HomeScreen {...props({ meetings: own, guestMax: 'off', onSetGuests: vi.fn() })} />);
    expect(screen.queryByTestId('guests-row')).toBeNull();
    cleanup();
    const others = labMeetings('few')!.map((m) => ({ ...m, is_host: false }));
    render(<HomeScreen {...props({ meetings: others, guestMax: 'open', onSetGuests: vi.fn() })} />);
    expect(screen.queryByTestId('guests-row')).toBeNull();
  });
});

describe('one-off notices', () => {
  it('home shows a dismissible notice (the host ended the meeting)', () => {
    const onDismissNotice = vi.fn();
    render(<HomeScreen {...props({ notice: 'The host ended the meeting for everyone.', onDismissNotice })} />);
    expect(screen.getByTestId('home-notice').textContent).toContain('The host ended the meeting');
    fireEvent.click(within(screen.getByTestId('home-notice')).getByRole('button'));
    expect(onDismissNotice).toHaveBeenCalled();
  });
  it('the sign-in screen shows it to a guest, and nothing without one', () => {
    const base = { lang: 'en' as Lang, onLang: vi.fn(), theme: 'dark' as const, onTheme: vi.fn(), onSignIn: vi.fn() };
    const { rerender } = render(<SignInScreen {...base} notice="The host ended the meeting for everyone." />);
    expect(screen.getByTestId('signin-notice').textContent).toContain('ended');
    rerender(<SignInScreen {...base} />);
    expect(screen.queryByTestId('signin-notice')).toBeNull();
  });
});
