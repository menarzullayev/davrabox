// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ActivityItem, Meeting, PersonalRoom } from '../api';
import { HomeScreen, type HomeScreenProps } from '../home/HomeScreen';
import type { HomeApi } from '../home/homeApi';
import { PersonalRoomCard } from '../home/PersonalRoomCard';
import { RecentActivity, formatDuration } from '../home/RecentActivity';
import { nextSlot, scheduledIso } from '../home/NewMeetingDialog';
import { RecordingsPage } from '../pages/RecordingsPage';
import { CHECKS, resultOf, rmsLevel } from '../pages/DevicesPage';
import { createBoard, deleteBoard, listBoards, loadBoard, renameBoard, saveBoard, type BoardStore } from '../pages/boards-store';
import { ToastProvider } from '../ui';
import { onLinkClick, pathFor, sectionFromPath, SECTIONS } from './nav';
import { LAB_NOW, labMeetings } from '../home/HomeLab';

afterEach(() => {
  cleanup();
  history.replaceState({}, '', '/');
});

const ROOM: PersonalRoom = { code: '41234567890', title: 'Alisher — personal room', waitingRoom: true, hasPasscode: false, guests: 'off' };

function fakeApi(over: Partial<HomeApi> = {}): HomeApi {
  return {
    personalRoom: vi.fn(async () => ({ room: null, policy: { requirePasscode: false, guestPolicy: 'off' as const } })),
    ensurePersonalRoom: vi.fn(async () => ROOM),
    updatePersonalRoom: vi.fn(async (p) => ({ ...ROOM, ...(p.waitingRoom !== undefined ? { waitingRoom: p.waitingRoom } : {}) })),
    regeneratePersonalRoom: vi.fn(async () => ({ ...ROOM, code: '49999999999' })),
    recentActivity: vi.fn(async () => ({ items: [] })),
    myRecordings: vi.fn(async () => ({ enabled: false, items: [] })),
    downloadRecording: vi.fn(async () => new Blob()),
    connectionTest: vi.fn(async () => ({ url: 'wss://x', token: 't' })),
    ...over,
  };
}
const wrap = (ui: React.ReactNode) => render(<ToastProvider dismissLabel="Dismiss" regionLabel="Notifications">{ui}</ToastProvider>);

describe('navigation paths', () => {
  it('maps every section to /app paths and back; unknown paths are home', () => {
    for (const s of SECTIONS) expect(sectionFromPath(pathFor(s))).toBe(s);
    expect(sectionFromPath('/app/')).toBe('home');
    expect(sectionFromPath('/app/nope')).toBe('home');
    expect(sectionFromPath('/app/settings/')).toBe('settings');
  });
  it('a plain click navigates in place; a modified click keeps the browser behaviour', () => {
    const prevent = vi.fn();
    onLinkClick({ button: 0, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: prevent }, '/app/meetings');
    expect(prevent).not.toHaveBeenCalled();
    onLinkClick({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, preventDefault: prevent }, '/app/meetings');
    expect(prevent).toHaveBeenCalled();
    expect(location.pathname).toBe('/app/meetings');
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
    profile: { name: 'Alisher Narzullayev' },
    isAdmin: false,
    meetings: labMeetings('few'),
    error: null,
    onDismissError: vi.fn(),
    initialCode: '',
    onJoin: vi.fn(async () => undefined),
    onCreate: vi.fn(async (d) => ({ id: 'n', code: '30011112222', title: d.title, waiting_room: true, locked: false, scheduled_at: d.scheduledAt ?? null, has_passcode: false, is_host: true }) as Meeting),
    onSignOut: vi.fn(),
    now: LAB_NOW,
    homeApi: fakeApi(),
    ...over,
  };
}

describe('left panel', () => {
  it('lists only the real sections in the agreed order; Admin only for admins; the current one is marked', () => {
    const { rerender } = render(<HomeScreen {...homeProps({ section: 'meetings' })} />);
    const nav = screen.getByRole('navigation', { name: 'Main menu' });
    const names = within(nav).getAllByRole('link').map((a) => a.textContent);
    expect(names).toEqual(['Home', 'Meetings', 'Recordings', 'Whiteboards', 'Settings', 'Help']);
    expect(within(nav).getByTestId('nav-meetings').getAttribute('aria-current')).toBe('page');
    rerender(<HomeScreen {...homeProps({ section: 'meetings', isAdmin: true })} />);
    expect(within(screen.getByRole('navigation', { name: 'Main menu' })).getAllByRole('link').map((a) => a.textContent)).toEqual(['Home', 'Meetings', 'Recordings', 'Whiteboards', 'Settings', 'Admin', 'Help']);
  });
  it('each section renders its page', async () => {
    const { rerender } = render(<HomeScreen {...homeProps({ section: 'meetings' })} />);
    expect(screen.getByTestId('meetings-page')).toBeTruthy();
    rerender(<HomeScreen {...homeProps({ section: 'settings' })} />);
    expect(screen.getByTestId('settings-page')).toBeTruthy();
    expect(screen.getByTestId('st-devices').getAttribute('href')).toBe('/app/devices');
    rerender(<HomeScreen {...homeProps({ section: 'whiteboards' })} />);
    expect(screen.getByTestId('whiteboards-page')).toBeTruthy();
    rerender(<HomeScreen {...homeProps({ section: 'recordings' })} />);
    expect(await screen.findByTestId('rc-off')).toBeTruthy();
  });
  it('home shows the three quick actions; Schedule opens the date-time form directly', async () => {
    render(<HomeScreen {...homeProps()} />);
    expect(screen.getByTestId('new-meeting')).toBeTruthy();
    expect(screen.getByTestId('join-form')).toBeTruthy();
    fireEvent.click(screen.getByTestId('schedule-meeting'));
    const dlg = await screen.findByRole('dialog', { name: 'Schedule a meeting' });
    expect(within(dlg).getByTestId('schedule-when')).toBeTruthy();
  });
});

describe('e2e selector compatibility', () => {
  it.each(['en', 'uz', 'ru'] as const)('the new-meeting dialog has the only "Create" button on home (%s)', async (lang) => {
    render(<HomeScreen {...homeProps({ lang })} />);
    await screen.findByTestId('pr-setup');
    fireEvent.click(screen.getByTestId('new-meeting'));
    await screen.findByTestId('new-meeting-submit');
    expect(screen.getAllByRole('button', { name: /Create|Yaratish|Создать/ })).toHaveLength(1);
  });
  it('in the admin console only the chosen section is the current page', () => {
    render(<HomeScreen {...homeProps({ isAdmin: true })} />);
    expect(screen.getByTestId('admin-link').getAttribute('aria-current')).toBeNull();
  });
});

describe('schedule helpers', () => {
  it('suggests the next half hour and refuses the past', () => {
    expect(nextSlot(new Date(2026, 10, 27, 9, 10))).toBe('2026-11-27T09:30');
    expect(nextSlot(new Date(2026, 10, 27, 9, 40))).toBe('2026-11-27T10:00');
    expect(nextSlot(new Date(2026, 10, 27, 23, 45))).toBe('2026-11-28T00:00');
    const now = new Date(2026, 10, 27, 9, 0);
    expect(scheduledIso('2026-11-27T08:00', now)).toBeNull();
    expect(scheduledIso('2026-13-01T08:00', now)).toBeNull();
    expect(scheduledIso('2026-11-27T10:00', now)).toBe(new Date(2026, 10, 27, 10, 0).toISOString());
  });
});

describe('personal room card', () => {
  it('first use: one button creates the room with a named title', async () => {
    const api = fakeApi();
    wrap(<PersonalRoomCard lang="en" api={api} name="Alisher" onJoin={vi.fn(async () => undefined)} />);
    fireEvent.click(await screen.findByTestId('pr-setup'));
    await waitFor(() => expect(screen.getByTestId('pr-code').textContent).toBe('412 3456 7890'));
    expect(api.ensurePersonalRoom).toHaveBeenCalledWith({ title: 'Alisher — personal room' });
  });
  it('an organization that requires passcodes asks for one before creating', async () => {
    const api = fakeApi({ personalRoom: vi.fn(async () => ({ room: null, policy: { requirePasscode: true, guestPolicy: 'off' as const } })) });
    wrap(<PersonalRoomCard lang="en" api={api} name="A" onJoin={vi.fn(async () => undefined)} />);
    expect(await screen.findByTestId('pr-setup-passcode')).toBeTruthy();
  });
  it('enter joins the own room; regenerate asks first and shows the new number', async () => {
    const onJoin = vi.fn(async () => undefined);
    const api = fakeApi({ personalRoom: vi.fn(async () => ({ room: ROOM, policy: { requirePasscode: false, guestPolicy: 'waiting_room' as const } })) });
    wrap(<PersonalRoomCard lang="en" api={api} name="A" onJoin={onJoin} />);
    fireEvent.click(await screen.findByTestId('pr-start'));
    expect(onJoin).toHaveBeenCalledWith('41234567890');
    fireEvent.click(screen.getByTestId('pr-regenerate'));
    expect(api.regeneratePersonalRoom).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('pr-regenerate-confirm'));
    await waitFor(() => expect(screen.getByTestId('pr-code').textContent).toBe('499 9999 9999'));
  });
  it('settings send only what changed; guests are offered only within the policy', async () => {
    const api = fakeApi({ personalRoom: vi.fn(async () => ({ room: ROOM, policy: { requirePasscode: false, guestPolicy: 'off' as const } })) });
    wrap(<PersonalRoomCard lang="en" api={api} name="A" onJoin={vi.fn(async () => undefined)} />);
    fireEvent.click(await screen.findByTestId('pr-edit'));
    const dlg = await screen.findByRole('dialog', { name: 'Room settings' });
    expect(within(dlg).queryByTestId('guest-mode')).toBeNull();
    fireEvent.click(within(dlg).getByTestId('pr-waiting'));
    fireEvent.submit(dlg.querySelector('form')!);
    await waitFor(() => expect(api.updatePersonalRoom).toHaveBeenCalledWith({ waitingRoom: false }));
  });
});

describe('recent activity', () => {
  const item = (over: Partial<ActivityItem> = {}): ActivityItem => ({
    id: 's1', meetingCode: '30011112222', title: 'Weekly sync', personal: false, isHost: true, startedAt: '2026-11-27T09:00:00Z', endedAt: '2026-11-27T09:42:00Z',
    durationSeconds: 42 * 60, participants: 4, guests: 1, peak: 3, files: 0, recordings: 0, ...over,
  });
  it('says so when nothing ended yet (no invented rows)', async () => {
    render(<RecentActivity lang="en" api={{ recentActivity: async () => ({ items: [] }) }} />);
    expect((await screen.findByTestId('ra-empty')).textContent).toBe('Ended meetings will appear here.');
  });
  it('shows duration and head count; files and recordings only when there were any', async () => {
    render(<RecentActivity lang="en" api={{ recentActivity: async () => ({ items: [item(), item({ id: 's2', files: 2, recordings: 1, guests: 0 })] }) }} />);
    const rows = await screen.findAllByTestId('ra-item');
    expect(within(rows[0]!).getByTestId('ra-duration').textContent).toBe('42 min');
    expect(within(rows[0]!).getByTestId('ra-people').textContent).toBe('Participants: 4, guests: 1');
    expect(within(rows[0]!).queryByTestId('ra-files')).toBeNull();
    expect(within(rows[1]!).getByTestId('ra-files').textContent).toBe('Files: 2');
    expect(within(rows[1]!).getByTestId('ra-recordings').textContent).toBe('Recordings: 1');
  });
  it('formats lengths as people read them', () => {
    expect(formatDuration('en', 20)).toBe('under a minute');
    expect(formatDuration('en', 65 * 60)).toBe('1 h 5 min');
    expect(formatDuration('uz', 5 * 60)).toBe('5 daq');
  });
});

describe('recordings page', () => {
  it('while recording is off it says so and lists nothing', async () => {
    wrap(<RecordingsPage lang="en" api={fakeApi()} />);
    expect(await screen.findByTestId('rc-off')).toBeTruthy();
    expect(screen.queryAllByTestId('rc-item')).toHaveLength(0);
  });
  it('lists finished recordings with a download', async () => {
    const api = fakeApi({ myRecordings: async () => ({ enabled: true, items: [{ id: 'r1', meetingCode: '30011112222', title: 'Demo', startedAt: '2026-11-27T09:00:00Z', endedAt: null, sizeBytes: 5 * 1_048_576 }] }) });
    wrap(<RecordingsPage lang="en" api={api} />);
    const row = await screen.findByTestId('rc-item');
    expect(within(row).getByText('5 MB')).toBeTruthy();
  });
});

describe('device check helpers', () => {
  it('maps LiveKit check results, warnings included', () => {
    expect(resultOf({ status: 3, logs: [] })).toBe('pass');
    expect(resultOf({ status: 3, logs: [{ level: 'warning' }] })).toBe('warn');
    expect(resultOf({ status: 4, logs: [] })).toBe('fail');
    expect(resultOf({ status: 2, logs: [] })).toBe('skipped');
    expect(CHECKS.map((c) => c.id)).toEqual(['ws', 'rtc', 'turn', 'proto', 'audio', 'video']);
  });
  it('silence is level 0, a loud signal is clipped to 1', () => {
    expect(rmsLevel(new Uint8Array(32).fill(128))).toBe(0);
    expect(rmsLevel(Uint8Array.from({ length: 32 }, (_, i) => (i % 2 ? 255 : 0)))).toBe(1);
  });
});

describe('personal boards store (device only)', () => {
  const mem = (): BoardStore => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
  };
  it('create, save, rename, list newest first, delete', () => {
    const s = mem();
    const a = createBoard('Plan', 1, s);
    const b = createBoard('  Ideas  ', 2, s);
    expect(listBoards(s).map((x) => x.name)).toEqual(['Ideas', 'Plan']);
    saveBoard(a.id, [{ id: 'e1' }], 3, s);
    expect(loadBoard(a.id, s)).toEqual([{ id: 'e1' }]);
    expect(listBoards(s)[0]!.id).toBe(a.id);
    renameBoard(b.id, 'Ideas v2', s);
    expect(listBoards(s).find((x) => x.id === b.id)!.name).toBe('Ideas v2');
    deleteBoard(a.id, s);
    expect(listBoards(s).map((x) => x.id)).toEqual([b.id]);
    expect(loadBoard(a.id, s)).toEqual([]);
  });
  it('ignores a damaged index and refuses bad ids', () => {
    const s = mem();
    s.setItem('davra.boards', '{"not":"a list"}');
    expect(listBoards(s)).toEqual([]);
    expect(loadBoard('../../x', s)).toEqual([]);
    expect(() => saveBoard('../x', [], 1, s)).toThrow();
  });
});
