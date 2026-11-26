import { describe, expect, it } from 'vitest';
import { defaultGuestMode, guestModeChoices } from './GuestModeSelect';

describe('guest mode choices', () => {
  it('offers only what the organization allows, keeping a current value above it visible', () => {
    expect(guestModeChoices('off')).toEqual(['off']);
    expect(guestModeChoices('waiting_room')).toEqual(['off', 'waiting_room']);
    expect(guestModeChoices('open')).toEqual(['off', 'waiting_room', 'open']);
    expect(guestModeChoices('waiting_room', 'open')).toEqual(['off', 'waiting_room', 'open']);
  });
  it('a new meeting defaults to the waiting room when guests are allowed', () => {
    expect(defaultGuestMode('off')).toBe('off');
    expect(defaultGuestMode('waiting_room')).toBe('waiting_room');
    expect(defaultGuestMode('open')).toBe('waiting_room');
  });
});
