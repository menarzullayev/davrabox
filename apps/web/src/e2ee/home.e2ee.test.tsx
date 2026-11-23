// @vitest-environment jsdom
// Creating, listing, copying and joining an E2EE meeting from the home screen. The key is made in the browser, goes only
// into the share link (after #) and never into a request.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Meeting } from '../api';
import { HomeScreen, type HomeScreenProps } from '../home/HomeScreen';
import { LAB_NOW, labMeetings } from '../home/HomeLab';
import { copyJoinLink } from '../home/Timeline';
import { createMeetingWithKey } from './create';
import { generateMeetingKey, loadStoredKey, storeKey } from './keys';

const CODE = '30011112222';
beforeEach(() => sessionStorage.clear());
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
    onCreate: vi.fn(async (d) => ({ id: 'new', code: CODE, title: d.title, waiting_room: d.waitingRoom, locked: false, scheduled_at: null, has_passcode: false, is_host: true, e2ee: d.e2ee }) as Meeting),
    onSignOut: vi.fn(),
    now: LAB_NOW,
    ...over,
  };
}

async function openDialog() {
  fireEvent.click(screen.getByTestId('new-meeting'));
  await raf();
}

describe('the new-meeting dialog', () => {
  it('offers an E2EE switch, off by default, with the consequences spelled out', async () => {
    render(<HomeScreen {...props()} />);
    await openDialog();
    const toggle = screen.getByTestId('e2ee-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(/Recording and file sharing are turned off/)).toBeTruthy();
    expect(screen.getByText(/cannot be changed later/)).toBeTruthy();
  });

  it('a plain meeting is created with e2ee false and no link dialog appears', async () => {
    const onCreate = vi.fn(props().onCreate);
    render(<HomeScreen {...props({ onCreate })} />);
    await openDialog();
    fireEvent.change(screen.getByTestId('meeting-title'), { target: { value: 'Standup' } });
    fireEvent.submit(document.getElementById('hm-new-form')!);
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ title: 'Standup', e2ee: false });
    await raf();
    expect(screen.queryByTestId('e2ee-link')).toBeNull();
  });

  it('an E2EE meeting is created with e2ee true and the host then sees the full link with the key after #', async () => {
    const key = generateMeetingKey();
    const onCreate = vi.fn(async (d: { title: string; waitingRoom: boolean; e2ee: boolean }) => {
      storeKey(CODE, key); // what App.doCreate does through createMeetingWithKey
      return { id: 'n', code: CODE, title: d.title, waiting_room: d.waitingRoom, locked: false, scheduled_at: null, has_passcode: false, is_host: true, e2ee: true } as Meeting;
    });
    render(<HomeScreen {...props({ onCreate })} />);
    await openDialog();
    fireEvent.change(screen.getByTestId('meeting-title'), { target: { value: 'Board' } });
    fireEvent.click(screen.getByTestId('e2ee-toggle'));
    fireEvent.submit(document.getElementById('hm-new-form')!);
    await waitFor(() => expect(onCreate.mock.calls[0]![0]).toMatchObject({ title: 'Board', e2ee: true }));
    const field = (await screen.findByTestId('e2ee-link')) as HTMLInputElement;
    expect(field.value).toBe(`${location.origin}/app?join=${CODE}#k=${key}`);
    expect(field.readOnly).toBe(true);
    expect(screen.getByText(/never sent to any server/)).toBeTruthy();
  });
});

describe('createMeetingWithKey', () => {
  it('makes the key in the browser, keeps it in sessionStorage and sends the server only the flag', async () => {
    const create = vi.fn(async (b: { title: string; e2ee?: boolean }) => ({ id: 'i', code: CODE, title: b.title, waiting_room: true, locked: false, scheduled_at: null, has_passcode: false, e2ee: b.e2ee === true }) as Meeting);
    const m = await createMeetingWithKey(create, { title: 'Secret', waitingRoom: true, e2ee: true });
    const key = loadStoredKey(CODE)!;
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(m.e2ee).toBe(true);
    expect(JSON.stringify(create.mock.calls)).not.toContain(key);
    expect(create.mock.calls[0]![0]).toEqual({ title: 'Secret', passcode: undefined, waitingRoom: true, e2ee: true });
  });

  it('a normal meeting generates and stores no key', async () => {
    const create = vi.fn(async (b: { title: string }) => ({ id: 'i', code: CODE, title: b.title, waiting_room: true, locked: false, scheduled_at: null, has_passcode: false, e2ee: false }) as Meeting);
    await createMeetingWithKey(create, { title: 'Plain', waitingRoom: true, e2ee: false });
    expect(loadStoredKey(CODE)).toBeNull();
    expect(create.mock.calls[0]![0]).not.toHaveProperty('e2ee', true);
  });

  it('if creating fails no key stays behind', async () => {
    const create = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(createMeetingWithKey(create, { title: 'X', waitingRoom: true, e2ee: true })).rejects.toThrow('boom');
    expect(sessionStorage.length).toBe(0);
  });
});

describe('the list', () => {
  it('marks an encrypted meeting', () => {
    const meetings = (labMeetings('few') ?? []).map((m, i) => (i === 0 ? { ...m, e2ee: true } : m));
    render(<HomeScreen {...props({ meetings })} />);
    const row = screen.getByText(meetings[0]!.title).closest('li')!;
    expect(within(row).getByText('Encrypted')).toBeTruthy();
  });
});

describe('copying a link', () => {
  const written: string[] = [];
  beforeEach(() => {
    written.length = 0;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (s: string) => void written.push(s) } });
  });

  it('includes the key when this tab holds it', async () => {
    const key = generateMeetingKey();
    storeKey(CODE, key);
    expect(await copyJoinLink('https://d.example', CODE)).toBe(true);
    expect(written[0]).toBe(`https://d.example/app?join=${CODE}#k=${key}`);
  });

  it('is the plain link when the tab has no key, and never invents one', async () => {
    await copyJoinLink('https://d.example', CODE);
    expect(written[0]).toBe(`https://d.example/app?join=${CODE}`);
  });
});

describe('the join field', () => {
  it('a pasted share link with a key remembers the key for that meeting and shows only the code', async () => {
    const key = generateMeetingKey();
    render(<HomeScreen {...props()} />);
    const input = document.querySelector<HTMLInputElement>('[data-testid=join-form] input[inputmode=numeric]')!;
    fireEvent.change(input, { target: { value: `https://davra.example/app?join=${CODE}#k=${key}` } });
    expect(input.value).toBe('300 1111 2222');
    expect(input.value).not.toContain(key);
    expect(loadStoredKey(CODE)).toBe(key);
  });

  it('a pasted link without a key stores nothing', () => {
    render(<HomeScreen {...props()} />);
    const input = document.querySelector<HTMLInputElement>('[data-testid=join-form] input[inputmode=numeric]')!;
    fireEvent.change(input, { target: { value: `https://davra.example/app?join=${CODE}` } });
    expect(loadStoredKey(CODE)).toBeNull();
  });
});
