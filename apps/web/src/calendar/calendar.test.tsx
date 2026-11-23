// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type Meeting } from '../api';
import { HomeScreen, type HomeScreenProps } from '../home/HomeScreen';
import { LAB_NOW, labMeetings } from '../home/HomeLab';
import { AddToCalendarDialog } from './AddToCalendarDialog';
import type { CalendarApi, ProviderStatus } from './calendarApi';
import { dictionaries } from '../i18n';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const meeting: Meeting = { id: 'm1', code: '12345678901', title: 'Sprint review', waiting_room: true, locked: false, scheduled_at: null, has_passcode: false, is_host: true };
const NOW = new Date(2026, 10, 24, 10, 12);

function fakeApi(status: ProviderStatus[], over: Partial<CalendarApi> = {}): CalendarApi & { [K in keyof CalendarApi]: ReturnType<typeof vi.fn> } {
  return {
    status: vi.fn(async () => status),
    start: vi.fn(async () => ({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' })),
    disconnect: vi.fn(async () => ({ disconnected: true })),
    createEvent: vi.fn(async () => ({ eventUrl: 'https://www.google.com/calendar/event?eid=1' })),
    ...over,
  } as never;
}

const both = (g: boolean, m: boolean): ProviderStatus[] => [
  { provider: 'google', configured: true, connected: g },
  { provider: 'microsoft', configured: true, connected: m },
];

function renderDialog(api: CalendarApi, navigate = vi.fn()) {
  render(<AddToCalendarDialog lang="en" token="tok" meeting={meeting} onClose={vi.fn()} api={api} navigate={navigate} now={NOW} />);
  return navigate;
}

describe('AddToCalendarDialog', () => {
  it('says so when no calendar provider is configured on the server', async () => {
    renderDialog(fakeApi([{ provider: 'google', configured: false, connected: false }, { provider: 'microsoft', configured: false, connected: false }]));
    expect(await screen.findByTestId('cal-none')).toBeTruthy();
    expect(screen.queryByTestId('cal-create')).toBeNull();
  });

  it('offers to connect when the provider is not connected and navigates to the consent url', async () => {
    const api = fakeApi(both(false, false));
    const navigate = renderDialog(api);
    fireEvent.click(await screen.findByTestId('cal-connect'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
    expect(api.start).toHaveBeenCalledWith('tok', 'google');
    expect(screen.queryByTestId('cal-create')).toBeNull();
  });

  it('creates the event with the chosen time, duration and attendees, then links to it', async () => {
    const api = fakeApi(both(true, false));
    renderDialog(api);
    const start = (await screen.findByTestId('cal-start')) as HTMLInputElement;
    expect(start.value).toBe('2026-11-24T10:30'); // next half hour from the injected clock
    fireEvent.change(start, { target: { value: '2026-12-01T09:00' } });
    fireEvent.change(screen.getByTestId('cal-duration'), { target: { value: '90' } });
    fireEvent.change(screen.getByTestId('cal-attendees'), { target: { value: 'ann@example.com, bob@example.org' } });
    fireEvent.click(screen.getByTestId('cal-create'));
    const link = (await screen.findByTestId('cal-event-link')) as HTMLAnchorElement;
    expect(link.href).toBe('https://www.google.com/calendar/event?eid=1');
    expect(link.rel).toContain('noopener');
    const [token, code, body] = api.createEvent.mock.calls[0] as [string, string, { provider: string; start: string; end: string; attendees: string[] }];
    expect(token).toBe('tok');
    expect(code).toBe('12345678901');
    expect(body.provider).toBe('google');
    expect(Date.parse(body.end) - Date.parse(body.start)).toBe(90 * 60_000);
    expect(body.attendees).toEqual(['ann@example.com', 'bob@example.org']);
  });

  it('refuses invalid attendees before calling the server', async () => {
    const api = fakeApi(both(true, false));
    renderDialog(api);
    fireEvent.change(await screen.findByTestId('cal-attendees'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByTestId('cal-create'));
    expect(await screen.findByTestId('cal-error')).toBeTruthy();
    expect(within(screen.getByTestId('cal-error')).getByRole('alert').textContent).toBe(dictionaries.en.calBadAttendees);
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('an expired connection (409) shows the reconnect message and the connect button again', async () => {
    const api = fakeApi(both(true, false), { createEvent: vi.fn(async () => Promise.reject(new ApiError(409))) });
    renderDialog(api);
    await screen.findByTestId('cal-start');
    fireEvent.click(screen.getByTestId('cal-create'));
    expect((await screen.findByTestId('cal-error')).textContent).toContain(dictionaries.en.calReconnect);
    expect(await screen.findByTestId('cal-connect')).toBeTruthy();
  });

  it('never renders a non-https event link returned by the server', async () => {
    const api = fakeApi(both(true, false), { createEvent: vi.fn(async () => ({ eventUrl: 'javascript:alert(1)' })) });
    renderDialog(api);
    await screen.findByTestId('cal-start');
    fireEvent.click(screen.getByTestId('cal-create'));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalled());
    expect(screen.queryByTestId('cal-event-link')).toBeNull();
  });

  it('disconnect calls the API and returns to the connect state', async () => {
    const api = fakeApi(both(true, false));
    renderDialog(api);
    fireEvent.click(await screen.findByTestId('cal-disconnect'));
    expect(await screen.findByTestId('cal-connect')).toBeTruthy();
    expect(api.disconnect).toHaveBeenCalledWith('tok', 'google');
  });
});

function homeProps(over: Partial<HomeScreenProps> = {}): HomeScreenProps {
  return {
    lang: 'en',
    onLang: vi.fn(),
    theme: 'dark',
    onTheme: vi.fn(),
    relayMode: false,
    onRelayMode: vi.fn(),
    profile: { name: 'Alisher' },
    isAdmin: false,
    meetings: labMeetings('few'),
    error: null,
    onDismissError: vi.fn(),
    initialCode: '',
    onJoin: vi.fn(async () => undefined),
    onCreate: vi.fn(async (d) => ({ ...meeting, title: d.title, is_host: true })),
    onSignOut: vi.fn(),
    now: LAB_NOW,
    ...over,
  };
}

describe('home integration', () => {
  it('shows the calendar action only on rows the user hosts, and only when a token is given', () => {
    const { unmount } = render(<HomeScreen {...homeProps()} />);
    expect(screen.queryAllByTestId('cal-row')).toHaveLength(0);
    unmount();
    render(<HomeScreen {...homeProps({ calendarToken: 'tok' })} />);
    const hosted = (labMeetings('few') ?? []).filter((m) => m.is_host).length;
    expect(hosted).toBeGreaterThan(0);
    expect(screen.getAllByTestId('cal-row')).toHaveLength(hosted);
  });

  it('reports the OAuth result once and cleans the address bar', async () => {
    window.history.replaceState(null, '', '/?calendar=connected&provider=google&join=12345678901');
    render(<HomeScreen {...homeProps({ calendarToken: 'tok' })} />);
    expect(await screen.findByText(dictionaries.en.calReturnConnected)).toBeTruthy();
    expect(window.location.search).toBe('?join=12345678901');
  });

  it('the create dialog offers "add to calendar" only with the integration on', async () => {
    const { unmount } = render(<HomeScreen {...homeProps()} />);
    fireEvent.click(screen.getByTestId('new-meeting'));
    expect(screen.queryByTestId('cal-after-create')).toBeNull();
    unmount();
    render(<HomeScreen {...homeProps({ calendarToken: 'tok' })} />);
    fireEvent.click(screen.getByTestId('new-meeting'));
    expect(screen.getByTestId('cal-after-create')).toBeTruthy();
  });
});
