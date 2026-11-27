// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { SettingItem, SettingsView } from '../api';
import { ToastProvider } from '../ui';
import { MySettings, matches } from './MySettings';
import { OrgSettings } from './OrgSettings';
import { JoinNotice } from './JoinRules';
import { OPEN_POLICY, accepts, maySend, parseRoomPolicy, startMedia } from '../call/policy';
import { passcodeFromSearch, withPasscode } from '../home/link-passcode';
import { appErrorKey } from '../errors';
import { ApiError } from '../api';
import { dictionaries } from '../i18n';

afterEach(cleanup);

const item = (key: string, over: Partial<SettingItem> = {}): SettingItem => ({ key, group: 'security', type: 'bool', value: true, orgValue: true, locked: false, ...over });
const VIEW: SettingsView = {
  items: [
    item('waitingRoom'),
    item('requirePasscode', { value: true, locked: true }),
    item('chat', { group: 'meeting', type: 'choice', options: ['off', 'host', 'everyone'], value: 'everyone', orgValue: 'everyone' }),
    item('emailLobby', { group: 'notifications' }),
    item('theme', { group: 'appearance', type: 'choice', options: ['system', 'light', 'dark'], value: 'dark', locked: true }),
  ],
  recordingEnabled: false,
  mailEnabled: false,
};
const wrap = (ui: React.ReactNode) => render(<ToastProvider dismissLabel="Dismiss" regionLabel="Notifications">{ui}</ToastProvider>);

describe('My settings page', () => {
  it('shows the groups, the lock and the mail notice; a locked setting cannot be changed', async () => {
    wrap(<MySettings lang="en" api={{ load: async () => VIEW, save: vi.fn() }} theme="dark" onTheme={vi.fn()} onLang={vi.fn()} />);
    await screen.findByTestId('my-settings');
    expect(screen.getByTestId('ms-group-security')).toBeTruthy();
    expect(screen.getByTestId('ms-locked-requirePasscode').textContent).toContain('Locked by your organization');
    expect((screen.getByTestId('set-requirePasscode') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Email is not set up on this server yet: notifications are not sent.')).toBeTruthy();
    expect(screen.getByTestId('ms-locked-theme')).toBeTruthy();
  });
  it('search filters by label and hint, in the person’s language', async () => {
    wrap(<MySettings lang="en" api={{ load: async () => VIEW, save: vi.fn() }} theme="dark" onTheme={vi.fn()} onLang={vi.fn()} />);
    await screen.findByTestId('my-settings');
    fireEvent.change(screen.getByTestId('ms-search'), { target: { value: 'lobby' } });
    expect(screen.queryByTestId('ms-group-security')).toBeNull();
    expect(screen.getByTestId('ms-group-notifications')).toBeTruthy();
    fireEvent.change(screen.getByTestId('ms-search'), { target: { value: 'zzz-nothing' } });
    expect(screen.getByTestId('ms-empty')).toBeTruthy();
    expect(matches('uz', { key: 'chat' }, 'chat')).toBe(true);
  });
  it('a change is saved at once', async () => {
    const save = vi.fn(async () => VIEW);
    wrap(<MySettings lang="en" api={{ load: async () => VIEW, save }} theme="dark" onTheme={vi.fn()} onLang={vi.fn()} />);
    fireEvent.click(await screen.findByTestId('set-waitingRoom'));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ waitingRoom: false }));
  });
  it('every catalog key has a label and a hint in all three languages', () => {
    const keys = ['waitingRoom', 'requirePasscode', 'guestMode', 'embedPasscode', 'rejoinAfterRemoval', 'e2ee', 'hostVideo', 'participantVideo', 'muteOnJoin', 'joinBeforeHost', 'personalRoomInstant', 'chat', 'privateChat', 'fileSending', 'screenShare', 'noShareWithGuests', 'reactions', 'activities', 'rename', 'joinLeaveSound', 'emailLobby', 'emailCancelled', 'emailNewDevice', 'style', 'theme', 'density', 'joinDisclaimer', 'countryRule', 'countries', 'autoRecord', 'confirmRecording', 'whoMayRecord', 'recordingRetentionDays'];
    for (const l of ['uz', 'ru', 'en'] as const) {
      const d = dictionaries[l] as Record<string, string>;
      for (const k of keys) {
        expect(d[`ms_${k}`], `${l} ms_${k}`).toBeTruthy();
        expect(d[`msh_${k}`], `${l} msh_${k}`).toBeTruthy();
      }
    }
  });
});

describe('admin meeting settings', () => {
  it('sends the changed default with its lock', async () => {
    const save = vi.fn(async () => VIEW);
    wrap(<OrgSettings lang="en" api={{ load: async () => VIEW, save }} />);
    await screen.findByTestId('org-settings');
    fireEvent.click(within(screen.getByTestId('os-waitingRoom')).getByTestId('os-lock-waitingRoom'));
    fireEvent.click(screen.getByTestId('os-save'));
    await waitFor(() => expect(save).toHaveBeenCalledWith({ waitingRoom: { value: true, locked: true } }));
  });
});

describe('room policy (applied by every receiving client)', () => {
  const host = { manager: true };
  const guest = { manager: false };
  it('chat off / host only / everyone with private chat', () => {
    const off = { ...OPEN_POLICY, chat: 'off' as const };
    expect(accepts(off, 'chat', guest, guest)).toBe(false);
    expect(accepts(off, 'chat', host, guest)).toBe(true); // the host side is never restricted
    const hostOnly = { ...OPEN_POLICY, chat: 'host' as const };
    expect(accepts(hostOnly, 'chat', guest, host)).toBe(false);
    expect(accepts(hostOnly, 'private', guest, host)).toBe(true);
    expect(accepts(hostOnly, 'private', guest, guest)).toBe(false);
    expect(accepts({ ...OPEN_POLICY, privateChat: false }, 'private', guest, guest)).toBe(false);
    expect(accepts({ ...OPEN_POLICY, fileSending: false }, 'chat', guest, guest, true)).toBe(false);
    expect(accepts({ ...OPEN_POLICY, reactions: false }, 'reaction', guest, guest)).toBe(false);
    expect(maySend(hostOnly, 'chat', guest, host)).toBe(true);
    expect(maySend(hostOnly, 'chat', guest)).toBe(false);
  });
  it('parses only a well-formed policy; anything else is the open default', () => {
    expect(parseRoomPolicy('{"policy":{"chat":"host","reactions":false}}')).toMatchObject({ chat: 'host', reactions: false, privateChat: true });
    expect(parseRoomPolicy('{"policy":{"chat":"everybody"}}').chat).toBe('everyone');
    expect(parseRoomPolicy('not json')).toEqual(OPEN_POLICY);
    expect(parseRoomPolicy(undefined)).toEqual(OPEN_POLICY);
  });
  it('start media follows mute-on-entry and the video settings', () => {
    const p = { ...OPEN_POLICY, muteOnJoin: true, participantVideo: false, hostVideo: false };
    expect(startMedia(p, { mic: true, cam: true }, { host: false, manager: false })).toEqual({ mic: false, cam: false });
    expect(startMedia(p, { mic: true, cam: true }, { host: true, manager: true })).toEqual({ mic: true, cam: false });
  });
});

describe('join rules on the client', () => {
  it('the notice is shown and accepted', () => {
    const accept = vi.fn();
    render(<JoinNotice lang="en" text="Recorded for quality." onAccept={accept} onCancel={vi.fn()} />);
    expect(screen.getByTestId('join-notice-text').textContent).toBe('Recorded for quality.');
    fireEvent.click(screen.getByTestId('join-notice-accept'));
    expect(accept).toHaveBeenCalled();
  });
  it('maps the new refusals to messages', () => {
    expect(appErrorKey(new ApiError(410, 'cancelled', 'cancelled'))).toBe('errCancelled');
    expect(appErrorKey(new ApiError(403, 'x', 'country_blocked'))).toBe('errCountryBlocked');
    expect(appErrorKey(new ApiError(400, 'x', 'passcode_required'))).toBe('errPasscodeRequired');
  });
  it('the passcode goes into the link before an E2EE key, and back out', () => {
    expect(withPasscode('https://x/app?join=12345678901#k=abc', 'p w')).toBe('https://x/app?join=12345678901&pwd=p%20w#k=abc');
    expect(withPasscode('https://x/app?join=1', null)).toBe('https://x/app?join=1');
    expect(passcodeFromSearch('?join=1&pwd=p%20w')).toBe('p w');
    expect(passcodeFromSearch('?pwd=' + 'x'.repeat(65))).toBeNull();
  });
});
