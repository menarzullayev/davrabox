// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError, type Profile, type SecurityView } from '../api';
import { ToastProvider } from '../ui';
import { ProfilePage } from './ProfilePage';
import type { ProfileApi } from './profileApi';
import { clampCrop, cropRect } from './AvatarEditor';
import { clock, dateText, setDisplay } from './display';
import { avatarOf } from '../Call';
import { formatClock } from '../home/logic';

afterEach(() => {
  cleanup();
  setDisplay({ timeZone: null, dateFormat: null, timeFormat: null });
});

const PROFILE: Profile = {
  name: 'Dilnoza Karimova',
  email: 'dilnoza@example.test',
  jobTitle: 'Analyst',
  departmentId: null,
  department: null,
  phone: null,
  timeZone: 'Asia/Tashkent',
  dateFormat: null,
  timeFormat: null,
  avatarUrl: null,
  departments: [{ id: 'd1', name: 'Sales' }],
};
const SECURITY: SecurityView = {
  password: true,
  totp: [],
  passkeys: [{ id: 'pk1', label: 'Laptop', createdAt: '2026-11-20T10:00:00.000Z' }],
  sessions: [
    { id: 's1', current: true, start: null, lastAccess: '2026-11-27T10:00:00.000Z', device: 'Windows', browser: 'Chrome', city: 'Tashkent', country: 'UZ', ip: '203.0.113.0/24' },
    { id: 's2', current: false, start: null, lastAccess: '2026-11-26T10:00:00.000Z', device: 'Android', browser: 'Chrome', city: null, country: null, ip: null },
  ],
  links: [{ provider: 'google', userName: 'd@gmail.test' }],
  providers: ['google', 'microsoft'],
};

function fakeApi(over: Partial<ProfileApi> = {}): ProfileApi {
  return {
    profile: vi.fn(async () => PROFILE),
    save: vi.fn(async (p) => ({ ...PROFILE, ...p }) as Profile),
    uploadAvatar: vi.fn(async () => ({ avatarUrl: '/api/v1/avatars/' + 'a'.repeat(32) })),
    removeAvatar: vi.fn(async () => undefined),
    security: vi.fn(async () => SECURITY),
    endSession: vi.fn(async () => undefined),
    endAllSessions: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
    calendars: vi.fn(async () => [
      { provider: 'google' as const, configured: true, connected: false },
      { provider: 'microsoft' as const, configured: false, connected: false },
    ]),
    connectCalendar: vi.fn(async () => ({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' })),
    disconnectCalendar: vi.fn(async () => undefined),
    ...over,
  };
}
const mount = (api: ProfileApi, extra: Partial<Parameters<typeof ProfilePage>[0]> = {}) =>
  render(
    <ToastProvider dismissLabel="Dismiss" regionLabel="Notifications">
      <ProfilePage lang="en" api={api} sid="s1" onSignedOutEverywhere={vi.fn()} {...extra} />
    </ToastProvider>,
  );

describe('profile page', () => {
  it('shows the visibility rule (owner decision 5) and links the privacy notice', async () => {
    mount(fakeApi());
    const n = await screen.findByTestId('pf-visibility');
    expect(n.textContent).toContain('Only organization admins also see your email and phone');
    expect(within(n).getByRole('link').getAttribute('href')).toBe('/privacy#legal-profile');
  });

  it('saves title, department, phone, time zone and formats', async () => {
    const api = fakeApi();
    mount(api);
    await screen.findByTestId('pf-info-form');
    fireEvent.change(screen.getByTestId('pf-title'), { target: { value: 'Lead analyst' } });
    fireEvent.change(screen.getByTestId('pf-phone'), { target: { value: '+998 90 123-45-67' } });
    fireEvent.submit(screen.getByTestId('pf-info-form'));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ jobTitle: 'Lead analyst', phone: '+998 90 123-45-67', timeZone: 'Asia/Tashkent', timeFormat: '24h', departmentId: null }));
  });

  it('a bad phone number is not sent', async () => {
    const api = fakeApi();
    mount(api);
    await screen.findByTestId('pf-info-form');
    fireEvent.change(screen.getByTestId('pf-phone'), { target: { value: 'call me maybe' } });
    expect((screen.getByTestId('pf-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('security goes through the identity provider: password, 2FA, passkeys use its own flows', async () => {
    const kcAction = vi.fn();
    mount(fakeApi(), { kcAction });
    fireEvent.click(await screen.findByTestId('pf-password-change'));
    expect(kcAction).toHaveBeenLastCalledWith('UPDATE_PASSWORD', '/app/profile');
    fireEvent.click(screen.getByTestId('pf-totp-add'));
    expect(kcAction).toHaveBeenLastCalledWith('CONFIGURE_TOTP', '/app/profile');
    fireEvent.click(screen.getByTestId('pf-passkey-add'));
    expect(kcAction).toHaveBeenLastCalledWith('webauthn-register-passwordless', '/app/profile');
    fireEvent.click(screen.getByRole('button', { name: 'Remove: Laptop' }));
    expect(kcAction).toHaveBeenLastCalledWith('delete_credential:pk1', '/app/profile');
  });

  it('lists sessions with this device first; ends another one; "end all" asks first', async () => {
    const api = fakeApi();
    const out = vi.fn();
    mount(api, { onSignedOutEverywhere: out });
    const rows = await screen.findAllByTestId('pf-session');
    expect(rows[0]!.hasAttribute('data-current')).toBe(true);
    expect(rows[0]!.textContent).toContain('Tashkent, UZ');
    expect(within(rows[0]!).queryByTestId('pf-session-end')).toBeNull();
    fireEvent.click(within(rows[1]!).getByTestId('pf-session-end'));
    await waitFor(() => expect(api.endSession).toHaveBeenCalledWith('s2'));
    fireEvent.click(screen.getByTestId('pf-session-end-all'));
    expect(api.endAllSessions).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('pf-session-end-all-confirm'));
    await waitFor(() => expect(out).toHaveBeenCalled());
  });

  it('linked accounts: unlink, link the other provider; the last sign-in way is explained', async () => {
    const link = vi.fn();
    const api = fakeApi({ unlink: vi.fn(async () => Promise.reject(new ApiError(409, '', 'last_sign_in'))) });
    mount(api, { link });
    fireEvent.click(await screen.findByTestId('pf-link-add-microsoft'));
    expect(link).toHaveBeenCalledWith('microsoft', 's1', '/app/profile');
    fireEvent.click(screen.getByTestId('pf-unlink-google'));
    expect(await screen.findByText('Set a password or a passkey first: this is your only way to sign in.')).toBeTruthy();
  });

  it('calendar: consent only on Connect; a provider without keys cannot be connected', async () => {
    const api = fakeApi();
    const away = vi.fn();
    mount(api, { navigateAway: away });
    expect(api.connectCalendar).not.toHaveBeenCalled();
    expect((await screen.findByTestId('pf-cal-connect-microsoft') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('pf-cal-connect-google'));
    await waitFor(() => expect(away).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?x=1'));
  });

  it('the security block says so when the server has no identity-provider admin access', async () => {
    mount(fakeApi({ security: vi.fn(async () => Promise.reject(new ApiError(503))) }));
    expect(await screen.findByText('Security settings are not available on this server yet.')).toBeTruthy();
  });
});

describe('square crop', () => {
  it('keeps the square inside the picture', () => {
    expect(clampCrop({ zoom: 0.5, cx: -10, cy: 9999 }, 800, 600)).toEqual({ zoom: 1, cx: 300, cy: 300 });
    expect(cropRect({ zoom: 2, cx: 400, cy: 300 }, 800, 600)).toEqual({ sx: 250, sy: 150, side: 300 });
  });
});

describe('display choices (time zone and formats)', () => {
  const t = new Date('2026-11-27T09:05:00Z');
  it('24-hour by default, 12-hour on request, in the chosen zone', () => {
    expect(clock(t, { timeZone: 'Asia/Tashkent', dateFormat: null, timeFormat: '24h' })).toBe('14:05');
    expect(clock(t, { timeZone: 'Asia/Tashkent', dateFormat: null, timeFormat: '12h' })).toBe('2:05 PM');
    expect(clock(t, { timeZone: 'UTC', dateFormat: null, timeFormat: null })).toBe('09:05');
  });
  it('date orders', () => {
    const c = { timeZone: 'UTC', timeFormat: null } as const;
    expect(dateText(t, 'en', { ...c, dateFormat: 'dmy' })).toBe('27.11.2026');
    expect(dateText(t, 'en', { ...c, dateFormat: 'mdy' })).toBe('11/27/2026');
    expect(dateText(t, 'en', { ...c, dateFormat: 'ymd' })).toBe('2026-11-27');
  });
  it('the meeting timeline follows the choice', () => {
    setDisplay({ timeZone: 'Asia/Tashkent', timeFormat: '12h' });
    expect(formatClock(t)).toBe('2:05 PM');
  });
});

describe('pictures in the call', () => {
  it('only a server-set random id becomes a picture URL', () => {
    expect(avatarOf({ avatar: 'f'.repeat(32) })).toBe(`/api/v1/avatars/${'f'.repeat(32)}`);
    expect(avatarOf({ avatar: 'https://evil.example/x.png' })).toBeNull();
    expect(avatarOf(undefined)).toBeNull();
  });
});
