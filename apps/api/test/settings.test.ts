import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import type { AuthedUser } from '../src/auth/auth.guard.js';
import { PERSONAL, SETTINGS, effective, validValue } from '../src/settings/catalog.js';
import { SettingsError, SettingsService } from '../src/settings/settings.service.js';
import { MeetingError, MeetingsService } from '../src/meetings/meetings.service.js';
import { checkJoinRules, countryAllowed, publishSources, roomPolicy } from '../src/meetings/meeting-policy.js';
import { Notifier } from '../src/notify/notifier.js';
import { PrefsError, PrefsService } from '../src/prefs/prefs.service.js';
import type { Mail } from '../src/notify/mailer.js';

// Integration against the real database (RLS) for "My settings" and organization locks (owner decisions 1-3 of 2026-11-27).
const cfg = loadConfig();
const adminUrl = process.env.MIGRATE_DATABASE_URL;
if (!adminUrl) throw new Error('MIGRATE_DATABASE_URL is required for tests');
const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 4 });
const owner = new Pool({ connectionString: adminUrl, max: 2 });
const settings = new SettingsService(pool, { recordingEnabled: false, mailEnabled: true });
const sent: Mail[] = [];
const notifier = new Notifier(pool, { enabled: true, send: async (m) => void sent.push(m) }, settings, 'https://meet.example.test');
const meetings = new MeetingsService(pool, cfg);
meetings.hooks = {
  hostSettings: (o, u) => settings.effectiveFor(o, u),
  orgRules: (o) => settings.orgRules(o),
  lobby: (o, m, w) => notifier.lobby(o, m, w),
};
meetings.onCancelled = (o, m, a, n) => notifier.cancelled(o, m, a, n);
const prefs = new PrefsService(pool);
const sfx = Math.random().toString(36).slice(2, 8);
const slugA = `st-a-${sfx}`;
const slugB = `st-b-${sfx}`;

async function mkUser(slug: string, sub: string, role: 'org_admin' | 'member'): Promise<AuthedUser> {
  const r = await pool.query('SELECT org_id, user_id FROM provision_user($1,$2,$3,$4,$5,$6)', [slug, slug, sub, `${sub}@t.local`, sub, role]);
  return { sub, email: `${sub}@t.local`, name: sub, orgSlug: slug, role, orgId: r.rows[0].org_id, userId: r.rows[0].user_id };
}
async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof SettingsError || e instanceof MeetingError || e instanceof PrefsError) return e.status;
    throw e;
  }
}

let admin: AuthedUser, alice: AuthedUser, bob: AuthedUser, outsider: AuthedUser;
beforeAll(async () => {
  admin = await mkUser(slugA, `sa-${sfx}`, 'org_admin');
  alice = await mkUser(slugA, `sl-${sfx}`, 'member');
  bob = await mkUser(slugA, `sb-${sfx}`, 'member');
  outsider = await mkUser(slugB, `so-${sfx}`, 'org_admin');
});
afterAll(async () => {
  await owner.query('DELETE FROM organizations WHERE slug IN ($1,$2)', [slugA, slugB]);
  await pool.end();
  await owner.end();
});

describe('catalog (decision 2)', () => {
  it('has the 26 personal settings in 5 groups, plus the organization rules and the recording group', () => {
    expect(PERSONAL).toHaveLength(26);
    const groups = (g: string) => PERSONAL.filter((s) => s.group === g).length;
    expect([groups('security'), groups('scheduling'), groups('meeting'), groups('notifications'), groups('appearance')]).toEqual([6, 5, 9, 3, 3]);
    expect(SETTINGS.filter((s) => s.orgOnly).map((s) => s.key)).toEqual(['joinDisclaimer', 'countryRule', 'countries']);
    expect(SETTINGS.filter((s) => s.recording).map((s) => s.key)).toEqual(['autoRecord', 'confirmRecording', 'whoMayRecord', 'recordingRetentionDays']);
  });
  it('validates values strictly', () => {
    expect(validValue('chat', 'everyone')).toBe('everyone');
    expect(validValue('chat', 'all')).toBeUndefined();
    expect(validValue('waitingRoom', 'true')).toBeUndefined();
    expect(validValue('countries', ['UZ', 'KZ', 'UZ'])).toEqual(['KZ', 'UZ']);
    expect(validValue('countries', ['uz'])).toBeUndefined();
    expect(validValue('joinDisclaimer', 'a\u0007b')).toBeUndefined();
    expect(validValue('nope', true)).toBeUndefined();
  });
  it('a locked organization value wins over the person; an unlocked one is only a default', () => {
    const org = new Map([
      ['chat', { value: 'host', locked: true }],
      ['reactions', { value: false, locked: false }],
    ]);
    const e = effective(org, new Map<string, boolean | string>([['chat', 'everyone'], ['reactions', true]]));
    expect(e['chat']).toBe('host');
    expect(e['reactions']).toBe(true);
    expect(effective(org, new Map())['reactions']).toBe(false);
  });
});

describe('my settings and organization locks', () => {
  it('a person changes an unlocked setting; bad values and organization-only keys are refused', async () => {
    const v = await settings.setMine(alice, { chat: 'host', muteOnJoin: true });
    expect(v.items.find((i) => i.key === 'chat')?.value).toBe('host');
    expect(await status(settings.setMine(alice, { chat: 'all' }))).toBe(400);
    expect(await status(settings.setMine(alice, { joinDisclaimer: 'x' }))).toBe(400);
    expect(await status(settings.setMine(alice, { autoRecord: true }))).toBe(400); // recording is off on this server
    expect(v.items.some((i) => i.group === 'recording')).toBe(false);
  });

  it('an admin lock applies to everybody at once and the person cannot change it (403)', async () => {
    await settings.setOrg(admin, { chat: { value: 'off', locked: true } });
    const v = await settings.view(alice);
    expect(v.items.find((i) => i.key === 'chat')).toMatchObject({ value: 'off', locked: true });
    expect(await status(settings.setMine(alice, { chat: 'everyone' }))).toBe(403);
    await settings.setOrg(admin, { chat: null });
    expect((await settings.view(alice)).items.find((i) => i.key === 'chat')?.value).toBe('host'); // her own choice again
  });

  it('the organization passcode policy is a locked requirePasscode', async () => {
    await owner.query('INSERT INTO org_policies (org_id, require_passcode) VALUES ($1, true) ON CONFLICT (org_id) DO UPDATE SET require_passcode = true', [admin.orgId]);
    expect((await settings.view(alice)).items.find((i) => i.key === 'requirePasscode')).toMatchObject({ value: true, locked: true });
    await owner.query('UPDATE org_policies SET require_passcode = false WHERE org_id = $1', [admin.orgId]);
  });

  it('appearance locks hold in the prefs endpoint too', async () => {
    await settings.setOrg(admin, { theme: { value: 'dark', locked: true } });
    expect(await status(prefs.set(alice, { theme: 'light' }))).toBe(403);
    expect((await prefs.get(alice)).prefs.theme).toBe('dark');
    await settings.setOrg(admin, { theme: null });
    expect(await status(prefs.set(alice, { theme: 'light' }))).toBe(200);
  });

  it('another organization sees none of it (RLS)', async () => {
    const v = await settings.orgView(outsider);
    expect(v.items.find((i) => i.key === 'chat')?.locked).toBe(false);
  });

  it('changes are audited', async () => {
    const a = await owner.query("SELECT action FROM audit_log WHERE org_id = $1 AND action IN ('settings.update','admin.settings.update')", [admin.orgId]);
    expect(a.rows.length).toBeGreaterThanOrEqual(3);
  });
});

describe('enforced by the server', () => {
  it('new meetings get the creator\'s defaults; "require a passcode" is enforced', async () => {
    await settings.setMine(bob, { waitingRoom: false, e2ee: true, requirePasscode: true });
    expect(await status(meetings.create(bob, { title: 'No passcode' }))).toBe(400);
    const m = await meetings.create(bob, { title: 'Defaults', passcode: 'bob-pass-1' });
    expect(m.waiting_room).toBe(false);
    expect(m.e2ee).toBe(true);
    await settings.setMine(bob, { requirePasscode: null, e2ee: null, waitingRoom: null });
  });

  it('cancel: the meeting cannot be joined, leaves the list, and the host side is told by email', async () => {
    const m = await meetings.create(alice, { title: 'Cancel me', waitingRoom: true });
    await meetings.setCohost(alice, m.code, bob.userId, true);
    sent.length = 0;
    expect(await status(meetings.cancel(bob, m.code))).toBe(403); // a co-host may not cancel
    await meetings.cancel(alice, m.code);
    expect(await status(meetings.join(bob, m.code))).toBe(410);
    expect((await meetings.list(alice)).some((x: { code: string }) => x.code === m.code)).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.map((x) => x.to)).toEqual([bob.email]);
    expect(sent[0]!.subject).toContain('Cancel me');
  });

  it('a lobby request emails the host once (not again within 10 minutes)', async () => {
    const m = await meetings.create(alice, { title: 'Lobby', waitingRoom: true });
    sent.length = 0;
    expect((await meetings.join(bob, m.code)).status).toBe('waiting');
    await new Promise((r) => setTimeout(r, 300));
    expect(sent.map((x) => x.to)).toEqual([alice.email]);
    expect(sent[0]!.text).toContain(`/app?join=${m.code}`);
    await settings.setMine(alice, { emailLobby: false });
    const m2 = await meetings.create(alice, { title: 'Quiet', waitingRoom: true });
    sent.length = 0;
    await meetings.join(bob, m2.code);
    await new Promise((r) => setTimeout(r, 300));
    expect(sent).toHaveLength(0);
  });

  it('join notice (428 until accepted) and country rule (403, audited; admins exempt)', async () => {
    const m = await meetings.create(alice, { title: 'Rules', waitingRoom: true });
    await settings.setOrg(admin, { joinDisclaimer: { value: 'Recorded for quality.' } });
    try {
      await meetings.join(bob, m.code);
      expect.unreachable();
    } catch (e) {
      expect((e as MeetingError).status).toBe(428);
      expect((e as MeetingError).extra).toMatchObject({ code: 'disclaimer', disclaimer: 'Recorded for quality.' });
    }
    expect((await meetings.join(bob, m.code, undefined, undefined, { acceptDisclaimer: true })).status).toBe('waiting');
    await settings.setOrg(admin, { joinDisclaimer: null, countryRule: { value: 'block' }, countries: { value: ['XX', 'RU'] } });
    expect(await status(meetings.join(bob, m.code, undefined, undefined, { country: 'RU' }))).toBe(403);
    expect(await status(meetings.join(bob, m.code, undefined, undefined, {}))).toBe(403); // unknown country counts as XX
    expect((await meetings.join(bob, m.code, undefined, undefined, { country: 'UZ' })).status).toBe('waiting');
    const a = await owner.query("SELECT target FROM audit_log WHERE org_id = $1 AND action = 'join.country.blocked'", [admin.orgId]);
    expect(a.rows.map((r) => r.target)).toContain(`${m.code}:RU`);
    await settings.setOrg(admin, { countryRule: null, countries: null });
  });

  it('pure rules: country lists, screen-share grant, room policy', () => {
    expect(countryAllowed({ joinDisclaimer: '', countryRule: 'allow', countries: ['UZ'] }, 'UZ')).toBe(true);
    expect(countryAllowed({ joinDisclaimer: '', countryRule: 'allow', countries: ['UZ'] }, undefined)).toBe(false);
    expect(countryAllowed({ joinDisclaimer: '', countryRule: 'block', countries: ['T1'] }, 'T1')).toBe(false);
    const p = roomPolicy({ screenShare: 'host', chat: 'off' } as never);
    expect(p.chat).toBe('off');
    expect(publishSources(p, false, 'off')).toHaveLength(2); // camera and microphone only
    expect(publishSources(p, true, 'off')).toBeUndefined(); // the host side keeps everything
    expect(publishSources(roomPolicy({ noShareWithGuests: true } as never), false, 'waiting_room')).toHaveLength(2);
    expect(publishSources(roomPolicy({ noShareWithGuests: true } as never), false, 'off')).toBeUndefined();
    expect(() => checkJoinRules({ joinDisclaimer: ' ', countryRule: 'off', countries: [] }, {}, async () => undefined)).not.toThrow();
  });

  it('a new device emails the person when they asked for it (the first sign-in is not "new")', async () => {
    sent.length = 0;
    expect(await notifier.newDevice(admin.orgId, alice.userId, 'Windows · Chrome', 'Tashkent, UZ')).toBe(1);
    expect(sent[0]!.text).toContain('Windows · Chrome, Tashkent, UZ');
    await settings.setMine(alice, { emailNewDevice: false });
    expect(await notifier.newDevice(admin.orgId, alice.userId, 'x', '')).toBe(0);
  });
});
