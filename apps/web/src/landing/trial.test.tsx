// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import { HomeScreen } from '../home/HomeScreen';
import { appErrorKey } from '../errors';
import { trialBanner } from './trial';

const DAY = 86_400_000;
const NOW = Date.parse('2026-12-01T10:00:00Z');
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

describe('trialBanner', () => {
  it('shows nothing for a paid organization, a far-off end or an already expired trial', () => {
    expect(trialBanner(null, NOW)).toBeNull();
    expect(trialBanner(at(3), NOW)).toBeNull();
    expect(trialBanner(at(2.5), NOW)).toBeNull(); // the reminder starts 2 days before the end (owner decision 5)
    expect(trialBanner(at(6), NOW)).toBeNull();
    expect(trialBanner(at(-0.01), NOW)).toBeNull(); // over: the server answers 402 instead
  });
  it('reminds in the last 2 days', () => {
    expect(trialBanner(at(2), NOW)).toEqual({ key: 'lnTrialEnds', n: 2 });
    expect(trialBanner(at(1.2), NOW)).toEqual({ key: 'lnTrialEnds', n: 2 });
  });
  it('has its own wording for the last day', () => {
    expect(trialBanner(at(0.9), NOW)).toEqual({ key: 'lnTrialEndsToday' });
    expect(trialBanner(at(0.001), NOW)).toEqual({ key: 'lnTrialEndsToday' });
  });
  it('ignores an unparsable date', () => {
    expect(trialBanner('not a date', NOW)).toBeNull();
  });
});

describe('appErrorKey', () => {
  it('maps the trial refusals to their own messages', () => {
    expect(appErrorKey(new ApiError(402, 'trial expired'))).toBe('lnErrTrialExpired');
    expect(appErrorKey(new ApiError(403, 'meeting is full'))).toBe('lnErrFull');
  });
  it('keeps the existing mappings', () => {
    expect(appErrorKey(new ApiError(404, ''))).toBe('errNotFound');
    expect(appErrorKey(new ApiError(429, ''))).toBe('errTooMany');
    expect(appErrorKey(new ApiError(403, 'wrong passcode'))).toBe('errWrongPasscode');
    expect(appErrorKey(new ApiError(403, 'meeting is locked'))).toBe('errLocked');
    expect(appErrorKey(new ApiError(500, ''))).toBe('errGeneric');
    expect(appErrorKey(new Error('x'))).toBe('errGeneric');
  });
});

describe('home screen banner', () => {
  afterEach(cleanup);
  const base = {
    lang: 'en' as const, onLang: () => undefined, theme: 'dark' as const, onTheme: () => undefined, relayMode: false, onRelayMode: () => undefined,
    profile: { name: 'Aziza' }, isAdmin: false, meetings: [], error: null, onDismissError: () => undefined, initialCode: '',
    onJoin: async () => undefined, onCreate: async () => { throw new Error('x'); }, onSignOut: () => undefined,
  };
  it('renders the trial notice when one is given and nothing otherwise', () => {
    const { rerender } = render(<HomeScreen {...base} banner={{ key: 'lnTrialEnds', n: 2 }} />);
    expect(screen.getByText('Your free trial ends in less than 2 days.')).toBeTruthy();
    rerender(<HomeScreen {...base} banner={null} />);
    expect(screen.queryByText(/free trial/)).toBeNull();
    rerender(<HomeScreen {...base} />);
    expect(screen.queryByText(/free trial/)).toBeNull();
  });
});
