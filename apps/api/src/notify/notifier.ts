import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { Mailer } from './mailer.js';

type Lang = 'uz' | 'ru' | 'en';
type Kind = 'lobby' | 'cancelled' | 'newDevice';

const TEXT: Record<Kind, Record<Lang, { subject: string; body: string }>> = {
  lobby: {
    uz: { subject: '{who} «{title}» uchrashuvida kutmoqda', body: '{who} «{title}» uchrashuvingizning kutish xonasida turibdi.\n\nQabul qilish uchun uchrashuvga kiring: {link}' },
    ru: { subject: '{who} ждёт во встрече «{title}»', body: '{who} ждёт в зале ожидания вашей встречи «{title}».\n\nЧтобы впустить, войдите во встречу: {link}' },
    en: { subject: '{who} is waiting in "{title}"', body: '{who} is waiting in the lobby of your meeting "{title}".\n\nJoin the meeting to let them in: {link}' },
  },
  cancelled: {
    uz: { subject: '«{title}» uchrashuvi bekor qilindi', body: '{who} «{title}» uchrashuvini bekor qildi ({when}). Bu uchrashuvga endi kirib bo‘lmaydi.' },
    ru: { subject: 'Встреча «{title}» отменена', body: '{who} отменил(а) встречу «{title}» ({when}). Войти в неё больше нельзя.' },
    en: { subject: 'Meeting "{title}" was cancelled', body: '{who} cancelled the meeting "{title}" ({when}). It can no longer be joined.' },
  },
  newDevice: {
    uz: { subject: 'DavraBox hisobingizga yangi qurilmadan kirildi', body: 'Hisobingizga yangi qurilmadan kirildi: {device}{place}.\n\nBu siz bo‘lmasangiz, parolingizni o‘zgartiring va sessiyani tugating: {link}' },
    ru: { subject: 'Вход в DavraBox с нового устройства', body: 'В ваш аккаунт вошли с нового устройства: {device}{place}.\n\nЕсли это были не вы, смените пароль и завершите сеанс: {link}' },
    en: { subject: 'New sign-in to your DavraBox account', body: 'Your account was signed in from a new device: {device}{place}.\n\nIf this was not you, change your password and end that session: {link}' },
  },
};

const fill = (s: string, v: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? '');
/** Nothing a person typed may turn into a header or a link-like line: control characters out, length capped. */
const clean = (s: string, max = 120) => s.replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, max);

interface Recipient {
  id: string;
  email: string;
  lang: Lang;
}

/**
 * Email notifications of "My settings" (decision 2: lobby, cancelled meeting, sign-in from a new device). Each goes only to
 * people whose effective setting is on. Never throws: a mail problem must not break a join or a sign-in.
 */
export class Notifier {
  private readonly recent = new Map<string, number>();

  constructor(
    private readonly pool: Pool,
    private readonly mailer: Mailer,
    private readonly settings: SettingsService,
    private readonly publicUrl: string,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.mailer.enabled;
  }

  private async recipients(c: PoolClient, ids: string[], setting: string): Promise<Recipient[]> {
    if (!ids.length) return [];
    const r = await c.query(
      `SELECT u.id, u.email, p.lang FROM users u LEFT JOIN user_prefs p ON p.user_id = u.id
        WHERE u.id = ANY($1::uuid[]) AND NOT u.disabled AND u.erased_at IS NULL`,
      [ids],
    );
    const out: Recipient[] = [];
    for (const x of r.rows as Array<{ id: string; email: string; lang: string | null }>) {
      if (!x.email || !/@/.test(x.email)) continue;
      const eff = await this.settings.effectiveIn(c, x.id);
      if (eff[setting] !== true) continue;
      out.push({ id: x.id, email: x.email, lang: x.lang === 'uz' || x.lang === 'ru' ? x.lang : 'en' });
    }
    return out;
  }

  private async send(kind: Kind, to: Recipient[], vars: Record<string, string>): Promise<number> {
    let n = 0;
    for (const r of to) {
      const t = TEXT[kind][r.lang];
      try {
        await this.mailer.send({ to: r.email, subject: fill(t.subject, vars), text: fill(t.body, vars) });
        n++;
      } catch {
        /* best effort */
      }
    }
    return n;
  }

  /** Someone waits in the lobby: the host and co-hosts who want it (at most once per 10 minutes per meeting and person). */
  async lobby(orgId: string, meetingId: string, who: string): Promise<number> {
    if (!this.mailer.enabled) return 0;
    try {
      const { to, m } = await withTenant(this.pool, orgId, async (c) => {
        const mr = await c.query('SELECT id, code, title, host_user_id FROM meetings WHERE id = $1', [meetingId]);
        const m = mr.rows[0] as { id: string; code: string; title: string; host_user_id: string } | undefined;
        if (!m) return { to: [] as Recipient[], m: null };
        const co = await c.query('SELECT user_id FROM meeting_cohosts WHERE meeting_id = $1', [meetingId]);
        const ids = [m.host_user_id, ...co.rows.map((x: { user_id: string }) => x.user_id)];
        return { to: await this.recipients(c, ids, 'emailLobby'), m };
      });
      if (!m) return 0;
      const due = to.filter((r) => {
        const k = `${meetingId}:${r.id}`;
        if ((this.recent.get(k) ?? 0) > this.now() - 10 * 60_000) return false;
        this.recent.set(k, this.now());
        return true;
      });
      if (this.recent.size > 5000) this.recent.clear();
      return await this.send('lobby', due, { who: clean(who, 60), title: clean(m.title), link: `${this.publicUrl}/app?join=${m.code}` });
    } catch {
      return 0;
    }
  }

  /** A meeting was cancelled: its host and co-hosts who want it, except the person who cancelled it. */
  async cancelled(orgId: string, meetingId: string, actorId: string, actorName: string): Promise<number> {
    if (!this.mailer.enabled) return 0;
    try {
      const { to, m } = await withTenant(this.pool, orgId, async (c) => {
        const mr = await c.query('SELECT title, scheduled_at, host_user_id FROM meetings WHERE id = $1', [meetingId]);
        const m = mr.rows[0] as { title: string; scheduled_at: Date | null; host_user_id: string } | undefined;
        if (!m) return { to: [] as Recipient[], m: null };
        const co = await c.query('SELECT user_id FROM meeting_cohosts WHERE meeting_id = $1', [meetingId]);
        const ids = [m.host_user_id, ...co.rows.map((x: { user_id: string }) => x.user_id)].filter((id) => id !== actorId);
        return { to: await this.recipients(c, ids, 'emailCancelled'), m };
      });
      if (!m) return 0;
      return await this.send('cancelled', to, { who: clean(actorName, 60), title: clean(m.title), when: m.scheduled_at ? m.scheduled_at.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—' });
    } catch {
      return 0;
    }
  }

  /** A sign-in from a device not seen before for this person. */
  async newDevice(orgId: string, userId: string, device: string, place: string): Promise<number> {
    if (!this.mailer.enabled) return 0;
    try {
      const to = await withTenant(this.pool, orgId, (c) => this.recipients(c, [userId], 'emailNewDevice'));
      return await this.send('newDevice', to, { device: clean(device, 80), place: place ? `, ${clean(place, 80)}` : '', link: `${this.publicUrl}/app/profile` });
    } catch {
      return 0;
    }
  }
}
