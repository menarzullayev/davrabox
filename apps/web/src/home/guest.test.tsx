// @vitest-environment jsdom
// Guest mode on the web client: the sign-in screen, the new-meeting dialog, the waiting screen and the API calls.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../api';
import { generateMeetingKey, storeKey } from '../e2ee/keys';
import { SignInScreen } from './AuthScreens';
import { NewMeetingDialog, type NewMeetingData } from './NewMeetingDialog';
import { Waiting } from './Waiting';
import { optionValues, pickOption } from '../ui/testing';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

const noop = () => undefined;
function signIn(over: Partial<React.ComponentProps<typeof SignInScreen>> = {}) {
  const props = { lang: 'en' as const, onLang: noop, theme: 'dark' as const, onTheme: noop, onSignIn: vi.fn(), onSignInToJoin: vi.fn(), onGuestJoin: vi.fn(async () => undefined), ...over };
  render(<SignInScreen {...props} />);
  return props;
}
const codeField = () => screen.getByLabelText(/Meeting code or link/i) as HTMLInputElement;

describe('sign-in screen: two steps', () => {
  const openJoin = async () => userEvent.click(screen.getByTestId('join-start'));

  it('step one is short: sign in, join with a code, create an organisation; no form yet', () => {
    signIn();
    expect(screen.getByRole('button', { name: /^Sign in/ })).toBeTruthy();
    expect(screen.getByTestId('join-start')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Create an organisation/i })).toBeTruthy();
    expect(screen.queryByLabelText(/Meeting code or link/i)).toBeNull();
    expect(screen.queryByTestId('guest-name')).toBeNull();
  });

  it('without any join handler there is no join entry at all', () => {
    signIn({ onGuestJoin: undefined, onSignInToJoin: undefined });
    expect(screen.queryByTestId('join-start')).toBeNull();
  });

  it('opens the join step and goes back, forgetting errors', async () => {
    signIn();
    await openJoin();
    expect(codeField()).toBeTruthy();
    expect(screen.getByTestId('guest-name')).toBeTruthy();
    await userEvent.click(screen.getByTestId('guest-go'));
    expect(codeField().getAttribute('aria-invalid')).toBe('true');
    await userEvent.click(screen.getByTestId('join-back'));
    await waitFor(() => expect(screen.getByTestId('join-start')).toBeTruthy());
    await openJoin();
    expect(codeField().getAttribute('aria-invalid')).toBeNull();
  });

  it('refuses to join as a guest without a valid code', async () => {
    const p = signIn();
    await openJoin();
    await userEvent.type(screen.getByTestId('guest-name'), 'Ali');
    await userEvent.click(screen.getByTestId('guest-go'));
    expect(p.onGuestJoin).not.toHaveBeenCalled();
    await userEvent.type(codeField(), '123');
    await userEvent.click(screen.getByTestId('guest-go'));
    expect(p.onGuestJoin).not.toHaveBeenCalled();
  });

  it('asks for a name; an empty or blank name is refused locally and the field is capped at 60', async () => {
    const p = signIn();
    await openJoin();
    await userEvent.type(codeField(), '12345678901');
    await userEvent.click(screen.getByTestId('guest-go'));
    expect(screen.getByRole('alert').textContent).toMatch(/Enter a name/i);
    expect(p.onGuestJoin).not.toHaveBeenCalled();
    const name = screen.getByTestId('guest-name') as HTMLInputElement;
    expect(name.maxLength).toBe(60);
    fireEvent.change(name, { target: { value: '   ' } });
    await userEvent.click(screen.getByTestId('guest-go'));
    expect(p.onGuestJoin).not.toHaveBeenCalled();
  });

  it('joins with the clean code, the trimmed name and the optional passcode', async () => {
    const p = signIn();
    await openJoin();
    await userEvent.type(codeField(), '123 4567 8901');
    await userEvent.type(screen.getByTestId('guest-name'), '  Ali   Valiyev ');
    await userEvent.type(screen.getByLabelText(/Meeting passcode/i), 'secret-1');
    await userEvent.click(screen.getByTestId('guest-go'));
    expect(p.onGuestJoin).toHaveBeenCalledWith('12345678901', 'Ali Valiyev', 'secret-1');
  });

  it('shows the API refusal in words (not found, wrong passcode, too many attempts) and stays on the form', async () => {
    for (const [err, text] of [
      [new ApiError(404), /not found|topilmadi/i],
      [new ApiError(403, 'wrong passcode'), /passcode/i],
      [new ApiError(429), /many|urinish/i],
    ] as const) {
      cleanup();
      signIn({ onGuestJoin: vi.fn(async () => Promise.reject(err)) });
      await openJoin();
      await userEvent.type(codeField(), '12345678901');
      await userEvent.type(screen.getByTestId('guest-name'), 'Ali');
      await userEvent.click(screen.getByTestId('guest-go'));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(text));
      expect(screen.getByTestId('guest-name')).toBeTruthy();
    }
  });

  it('"Sign in and join" keeps the code for after sign-in and never calls the guest path', async () => {
    const p = signIn();
    await openJoin();
    await userEvent.type(codeField(), '12345678901');
    await userEvent.click(screen.getByRole('button', { name: /^Sign in and join$/ }));
    expect(p.onSignInToJoin).toHaveBeenCalledWith('12345678901');
    expect(p.onGuestJoin).not.toHaveBeenCalled();
  });

  it('with only the account path the join form submits "Sign in and join"', async () => {
    const p = signIn({ onGuestJoin: undefined });
    await openJoin();
    expect(screen.queryByTestId('guest-name')).toBeNull();
    await userEvent.type(codeField(), '12345678901');
    await userEvent.click(screen.getByRole('button', { name: /^Sign in and join$/ }));
    expect(p.onSignInToJoin).toHaveBeenCalledWith('12345678901');
  });

  it('a meeting link starts on the join step with the code filled in', () => {
    signIn({ initialCode: '12345678901' });
    expect(screen.queryByTestId('join-start')).toBeNull();
    expect(codeField().value).toBe('123 4567 8901');
  });
});

describe('new meeting dialog: guests', () => {
  const baseProps = { lang: 'en' as const, open: true, onClose: noop, onCreated: noop };
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
      this.open = false;
    };
  });
  const meeting = { id: 'm', code: '30011112222', title: 'T', waiting_room: true, locked: false, scheduled_at: null, has_passcode: false };

  it('shows no guest choice while the organization does not allow guests', () => {
    render(<NewMeetingDialog {...baseProps} onCreate={vi.fn(async () => meeting)} guestMax="off" />);
    expect(screen.queryByTestId('guest-mode')).toBeNull();
  });

  it('offers only what the organization allows', () => {
    const { unmount } = render(<NewMeetingDialog {...baseProps} onCreate={vi.fn(async () => meeting)} guestMax="waiting_room" />);
    expect(optionValues(screen.getByTestId('guest-mode'))).toEqual(['off', 'waiting_room']);
    unmount();
    render(<NewMeetingDialog {...baseProps} onCreate={vi.fn(async () => meeting)} guestMax="open" />);
    expect(optionValues(screen.getByTestId('guest-mode'))).toEqual(['off', 'waiting_room', 'open']);
  });

  it('sends the chosen mode, and nothing when guests stay off', async () => {
    const onCreate = vi.fn(async (_d: NewMeetingData) => meeting);
    render(<NewMeetingDialog {...baseProps} onCreate={onCreate} guestMax="open" />);
    await userEvent.type(screen.getByTestId('meeting-title'), 'Standup');
    pickOption('guest-mode', 'waiting_room');
    fireEvent.submit(document.getElementById('hm-new-form')!);
    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate.mock.calls[0]![0]).toMatchObject({ title: 'Standup', guests: 'waiting_room' });

    cleanup();
    const second = vi.fn(async (_d: NewMeetingData) => meeting);
    render(<NewMeetingDialog {...baseProps} onCreate={second} guestMax="open" />);
    await userEvent.type(screen.getByTestId('meeting-title'), 'Quiet');
    fireEvent.submit(document.getElementById('hm-new-form')!);
    await waitFor(() => expect(second).toHaveBeenCalled());
    expect(second.mock.calls[0]![0].guests ?? 'off').toBe('off');
  });
});

describe('waiting screen: guest polling', () => {
  it('polls with the guest session token, never with a member token, and hands over the join', async () => {
    const joined = { status: 'joined' as const, token: 't', url: 'wss://x', meetingId: 'm', title: 'T', isHost: false, guest: true };
    const guestStatus = vi.spyOn(api, 'guestStatus').mockResolvedValue(joined);
    const memberStatus = vi.spyOn(api, 'requestStatus');
    const onAdmitted = vi.fn();
    render(<Waiting lang="en" code="12345678901" requestId="rid" guestToken="gtok" onAdmitted={onAdmitted} onFailed={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => expect(onAdmitted).toHaveBeenCalledWith(joined));
    expect(guestStatus).toHaveBeenCalledWith('gtok', 'rid');
    expect(memberStatus).not.toHaveBeenCalled();
  });

  it('reports a refusal (the host declined) and stops polling', async () => {
    const guestStatus = vi.spyOn(api, 'guestStatus').mockRejectedValue(new ApiError(403, 'the host declined your request'));
    const onFailed = vi.fn();
    render(<Waiting lang="en" code="12345678901" requestId="rid" guestToken="gtok" onAdmitted={vi.fn()} onFailed={onFailed} onCancel={vi.fn()} />);
    await waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1));
    expect(guestStatus).toHaveBeenCalledTimes(1);
  });
});

describe('guest API calls', () => {
  it('guestJoin sends no Authorization header and only the name (and passcode when given)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (..._a: Parameters<typeof fetch>) => new Response(JSON.stringify({ status: 'waiting', requestId: 'r', guestToken: 'g' }), { status: 200 }));
    await api.guestJoin('12345678901', 'Ali');
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const [url, init] = calls[0]!;
    expect(String(url)).toBe('/api/v1/guest/meetings/12345678901/join');
    expect((init!.headers as Record<string, string>)['Authorization']).toBeUndefined();
    expect(JSON.parse(String(init!.body))).toEqual({ name: 'Ali' });
    await api.guestJoin('12345678901', 'Ali', 'pw-123456');
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ name: 'Ali', passcode: 'pw-123456' });
  });

  it('guestStatus uses only the guest token; a refusal becomes an ApiError', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (..._a: Parameters<typeof fetch>) => new Response(JSON.stringify({ message: 'the host declined your request' }), { status: 403 }));
    await expect(api.guestStatus('gtok', 'rid')).rejects.toMatchObject({ status: 403, detail: 'the host declined your request' });
    expect((((fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0]![1]).headers as Record<string, string>)['Authorization']).toBe('Bearer gtok');
  });

  it('a meeting key held by this tab can never ride along in a guest call', async () => {
    const key = generateMeetingKey();
    storeKey('12345678901', key);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (..._a: Parameters<typeof fetch>) => new Response('{}', { status: 200 }));
    await expect(api.guestJoin('12345678901', key)).rejects.toThrow(/refusing to send/);
    await expect(api.guestJoin('12345678901', 'Ali', key)).rejects.toThrow(/refusing to send/);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(api.guestJoin('12345678901', 'Ali')).resolves.toBeDefined();
  });
});

describe('sign-in screen: Back navigation', () => {
  afterEach(() => history.replaceState(null, '', '/'));

  it('opening the join step adds a history entry and the system Back closes the step, not the app', async () => {
    history.replaceState(null, '', '/app');
    const before = history.length;
    signIn();
    await userEvent.click(screen.getByTestId('join-start'));
    expect(history.length).toBe(before + 1);
    expect(codeField()).toBeTruthy();
    history.back();
    await waitFor(() => expect(screen.getByTestId('join-start')).toBeTruthy());
    expect(screen.queryByLabelText(/Meeting code or link/i)).toBeNull();
  });

  it('the on-screen Back button does the same through the history, leaving one entry behind', async () => {
    history.replaceState(null, '', '/app');
    signIn();
    await userEvent.click(screen.getByTestId('join-start'));
    await userEvent.click(screen.getByTestId('join-back'));
    await waitFor(() => expect(screen.getByTestId('join-start')).toBeTruthy());
    expect((history.state as { siJoin?: boolean } | null)?.siJoin).toBeFalsy();
  });

  it('a meeting link opens straight on the join step; its Back button still works without a history entry', async () => {
    history.replaceState(null, '', '/app');
    signIn({ initialCode: '12345678901' });
    expect(codeField()).toBeTruthy();
    await userEvent.click(screen.getByTestId('join-back'));
    expect(screen.getByTestId('join-start')).toBeTruthy();
  });
});

describe('sign-in screen: accessibility names', () => {
  it('the sign-in screen has one language and appearance entry (settings panel), no separate language buttons', () => {
    signIn();
    expect(screen.queryByRole('group', { name: 'Language' })).toBeNull();
    expect(screen.getByTestId('theme-toggle')).toBeTruthy();
    expect(screen.getByTestId('settings')).toBeTruthy();
  });

  it('the sign-in note says what happens in three languages without repeating the button', () => {
    for (const lang of ['uz', 'ru', 'en'] as const) {
      cleanup();
      signIn({ lang });
      const note = document.querySelector('.si__card-text')!.textContent!;
      expect(note.length).toBeGreaterThan(20);
      expect(note).not.toMatch(/tugmasi|Кнопка|button/i);
    }
  });
});
