// "My settings" (owner decisions 1-3 of 2026-11-27, davrabox-builds/decisions/2026-11-27-settings-vs-zoom.md): the curated list,
// its built-in defaults and value rules. One source of truth: the API validates against it, enforces it, and serves it to the
// settings page (which renders whatever this list says, in the person's language).

export type SettingValue = boolean | string | string[] | number;

interface Base<T extends SettingValue> {
  key: string;
  group: 'security' | 'scheduling' | 'meeting' | 'notifications' | 'appearance' | 'recording' | 'organization';
  /** Built-in default when neither the organization nor the person chose. */
  def: T;
  /** Only an organization admin sets it (no personal value). */
  orgOnly?: boolean;
  /** Shown and enforced only while meeting recording is switched on (decision 3). */
  recording?: boolean;
}
export type SettingDef =
  | (Base<boolean> & { type: 'bool' })
  | (Base<string> & { type: 'choice'; options: readonly string[] })
  | (Base<string> & { type: 'text'; max: number })
  | (Base<string[]> & { type: 'countries' })
  | (Base<number> & { type: 'int'; min: number; max: number });

export const SETTINGS: readonly SettingDef[] = [
  // Security (6)
  { key: 'waitingRoom', group: 'security', type: 'bool', def: true },
  { key: 'requirePasscode', group: 'security', type: 'bool', def: false },
  { key: 'guestMode', group: 'security', type: 'choice', options: ['off', 'waiting_room', 'open'], def: 'off' },
  { key: 'embedPasscode', group: 'security', type: 'bool', def: false },
  { key: 'rejoinAfterRemoval', group: 'security', type: 'bool', def: false },
  { key: 'e2ee', group: 'security', type: 'bool', def: false },
  // Scheduling (5)
  { key: 'hostVideo', group: 'scheduling', type: 'bool', def: true },
  { key: 'participantVideo', group: 'scheduling', type: 'bool', def: true },
  { key: 'muteOnJoin', group: 'scheduling', type: 'bool', def: false },
  { key: 'joinBeforeHost', group: 'scheduling', type: 'bool', def: true },
  { key: 'personalRoomInstant', group: 'scheduling', type: 'bool', def: false },
  // In meeting (9)
  { key: 'chat', group: 'meeting', type: 'choice', options: ['off', 'host', 'everyone'], def: 'everyone' },
  { key: 'privateChat', group: 'meeting', type: 'bool', def: true },
  { key: 'fileSending', group: 'meeting', type: 'bool', def: true },
  { key: 'screenShare', group: 'meeting', type: 'choice', options: ['host', 'all'], def: 'all' },
  { key: 'noShareWithGuests', group: 'meeting', type: 'bool', def: false },
  { key: 'reactions', group: 'meeting', type: 'bool', def: true },
  { key: 'activities', group: 'meeting', type: 'bool', def: true },
  { key: 'rename', group: 'meeting', type: 'bool', def: false },
  { key: 'joinLeaveSound', group: 'meeting', type: 'bool', def: false },
  // Notifications (3)
  { key: 'emailLobby', group: 'notifications', type: 'bool', def: true },
  { key: 'emailCancelled', group: 'notifications', type: 'bool', def: true },
  { key: 'emailNewDevice', group: 'notifications', type: 'bool', def: true },
  // Appearance (3): stored in user_prefs; listed here for organization defaults and locks.
  { key: 'style', group: 'appearance', type: 'text', max: 32, def: '' },
  { key: 'theme', group: 'appearance', type: 'choice', options: ['system', 'light', 'dark'], def: 'system' },
  { key: 'density', group: 'appearance', type: 'choice', options: ['compact', 'comfortable', 'spacious'], def: 'comfortable' },
  // Organization only (2)
  { key: 'joinDisclaimer', group: 'organization', type: 'text', max: 2000, def: '', orgOnly: true },
  { key: 'countryRule', group: 'organization', type: 'choice', options: ['off', 'allow', 'block'], def: 'off', orgOnly: true },
  { key: 'countries', group: 'organization', type: 'countries', def: [], orgOnly: true },
  // Recording (behind the recording switch)
  { key: 'autoRecord', group: 'recording', type: 'bool', def: false, recording: true },
  { key: 'confirmRecording', group: 'recording', type: 'bool', def: true, recording: true },
  { key: 'whoMayRecord', group: 'recording', type: 'choice', options: ['host', 'cohost'], def: 'cohost', recording: true },
  { key: 'recordingRetentionDays', group: 'recording', type: 'int', min: 1, max: 365, def: 90, recording: true },
];

export const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
/** The 28 personal settings of decision 2 (the two organization-only rules and recording are separate). */
export const PERSONAL = SETTINGS.filter((s) => !s.orgOnly && !s.recording);

/** The value if it is valid for the setting, else undefined. */
export function validValue(key: string, v: unknown): SettingValue | undefined {
  const d = BY_KEY.get(key);
  if (!d) return undefined;
  switch (d.type) {
    case 'bool':
      return typeof v === 'boolean' ? v : undefined;
    case 'choice':
      return typeof v === 'string' && d.options.includes(v) ? v : undefined;
    case 'text':
      return typeof v === 'string' && v.length <= d.max && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(v) ? v : undefined;
    case 'countries':
      return Array.isArray(v) && v.length <= 250 && v.every((c) => typeof c === 'string' && /^[A-Z]{2}$/.test(c)) ? [...new Set(v as string[])].sort() : undefined;
    case 'int':
      return typeof v === 'number' && Number.isInteger(v) && v >= d.min && v <= d.max ? v : undefined;
  }
}

export type Effective = Record<string, SettingValue>;

/**
 * The value that applies: a locked organization value wins, then the person's own choice, then the organization's default,
 * then the built-in default (decision 1: admins set defaults and may lock; people change what is not locked).
 */
export function effective(org: Map<string, { value: SettingValue; locked: boolean }>, mine: Map<string, SettingValue>): Effective {
  const out: Effective = {};
  for (const d of SETTINGS) {
    const o = org.get(d.key);
    if (o?.locked) out[d.key] = o.value;
    else if (!d.orgOnly && mine.has(d.key)) out[d.key] = mine.get(d.key)!;
    else if (o) out[d.key] = o.value;
    else out[d.key] = d.def;
  }
  return out;
}
