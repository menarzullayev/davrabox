import type { GuestMode } from '../api';
import type { Lang } from '../i18n';
import { Select } from '../ui';
import { tx } from './text';

const RANK: Record<GuestMode, number> = { off: 0, waiting_room: 1, open: 2 };

/** The default for a new meeting: the waiting room when the organization allows guests at all, otherwise off. */
export function defaultGuestMode(max: GuestMode): GuestMode {
  return max === 'off' ? 'off' : 'waiting_room';
}

/** The choices a host has under the organization's limit; a current value above the limit stays listed so it is not hidden. */
export function guestModeChoices(max: GuestMode, current?: GuestMode): GuestMode[] {
  return (['off', 'waiting_room', 'open'] as const).filter((m) => RANK[m] <= RANK[max] || m === current);
}

/** "Guests (no account)": who may join without an account, within what the organization allows. */
export function GuestModeSelect({ lang, value, max, onChange, disabled, testId = 'guest-mode' }: { lang: Lang; value: GuestMode; max: GuestMode; onChange: (m: GuestMode) => void; disabled?: boolean; testId?: string }) {
  const label: Record<GuestMode, string> = { off: tx(lang, 'hNewGuestsOff'), waiting_room: tx(lang, 'hNewGuestsWait'), open: tx(lang, 'hNewGuestsOpen') };
  return (
    <Select label={tx(lang, 'hNewGuests')} hint={tx(lang, 'hNewGuestsHint')} data-testid={testId} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as GuestMode)}>
      {guestModeChoices(max, value).map((m) => (
        <option key={m} value={m}>
          {label[m]}
        </option>
      ))}
    </Select>
  );
}
