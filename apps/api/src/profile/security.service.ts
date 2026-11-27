import type { Pool } from 'pg';
import type { SelfServiceIdentity } from '../admin/identity-admin.js';
import type { AuthedUser } from '../auth/auth.guard.js';
import { withTenant } from '../db/tenant.js';
import { ProfileError } from './profile.service.js';

/** What the API saw of a request, for "Where you're signed in". */
export interface SeenRequest {
  userAgent?: string;
  ip?: string;
  country?: string;
  city?: string;
}

export interface SecurityView {
  /** Sign-in methods; secrets never leave the identity provider. */
  password: boolean;
  totp: Array<{ id: string; label: string | null; createdAt: string | null }>;
  passkeys: Array<{ id: string; label: string | null; createdAt: string | null }>;
  sessions: Array<{ id: string; current: boolean; start: string | null; lastAccess: string | null; device: string | null; browser: string | null; city: string | null; country: string | null; ip: string | null }>;
  links: Array<{ provider: string; userName: string | null }>;
  /** Providers the realm offers for linking (Google, Microsoft), configured ones only. */
  providers: string[];
}

/** The network part of an address only: /24 for IPv4, /48 for IPv6 (enough to recognise a place, not a household). */
export function ipPrefix(ip: string | undefined): string | null {
  if (!ip) return null;
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(ip);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (/^[0-9a-f:]+$/i.test(ip) && ip.includes(':')) {
    const full = ip.split('::')[0]!.split(':').filter(Boolean).slice(0, 3);
    return full.length ? `${full.join(':')}::/48` : null;
  }
  return null;
}

/** A short device and browser name from a user agent ("Windows", "Chrome"); null when unknown. */
export function describeAgent(ua: string | null): { device: string | null; browser: string | null } {
  if (!ua) return { device: null, browser: null };
  const device = /DavraBox-Android|Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPad|iOS/i.test(ua)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/i.test(ua)
          ? 'macOS'
          : /Linux|X11/i.test(ua)
            ? 'Linux'
            : null;
  const browser = /Electron\//.test(ua)
    ? 'DavraBox desktop'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /OPR\//.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : null;
  return { device, browser };
}

/**
 * Self-service security block (owner decision 3). Password, two-step verification and passkeys are changed through the
 * identity provider's own flows (the browser goes there); this service only lists what exists, ends sessions of the same
 * person and removes a linked account when another way to sign in remains. Organization-wide 2FA stays as it is.
 */
export class SecurityService {
  private readonly recent = new Map<string, number>();
  /** Set by the application module: email about a sign-in from a device not seen before ("My settings"). */
  onNewDevice: ((orgId: string, userId: string, device: string, place: string) => Promise<unknown>) | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly idp: SelfServiceIdentity | null,
    private readonly now: () => number = Date.now,
  ) {}

  private need(): SelfServiceIdentity {
    if (!this.idp) throw new ProfileError(503, 'idp_off', 'the identity provider admin client is not configured');
    return this.idp;
  }

  /** Remembers the device of a signed-in session (at most once per 5 minutes per session; never throws). */
  async record(user: AuthedUser, seen: SeenRequest): Promise<void> {
    if (!user.sid) return;
    const key = `${user.userId}:${user.sid}`;
    const t = this.now();
    if ((this.recent.get(key) ?? 0) > t - 5 * 60_000) return;
    this.recent.set(key, t);
    if (this.recent.size > 10_000) this.recent.clear();
    const country = seen.country && /^[A-Z]{2}$/.test(seen.country) && seen.country !== 'XX' && seen.country !== 'T1' ? seen.country : null;
    const city = seen.city ? seen.city.slice(0, 80) : null;
    try {
      const isNew = await withTenant(this.pool, user.orgId, async (c) => {
        const r = await c.query(
          `INSERT INTO user_session_devices (user_id, org_id, sid, user_agent, ip_prefix, country, city) VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (user_id, sid) DO UPDATE SET last_seen = now(), user_agent = EXCLUDED.user_agent, ip_prefix = EXCLUDED.ip_prefix,
             country = coalesce(EXCLUDED.country, user_session_devices.country), city = coalesce(EXCLUDED.city, user_session_devices.city)
           RETURNING (xmax = 0) AS inserted`,
          [user.userId, user.orgId, user.sid, seen.userAgent?.slice(0, 300) ?? null, ipPrefix(seen.ip), country, city],
        );
        if ((r.rows[0] as { inserted: boolean }).inserted !== true) return false;
        // "New device": a browser/device this person has not used in any other remembered session.
        const same = await c.query('SELECT 1 FROM user_session_devices WHERE user_id = $1 AND sid <> $2 AND user_agent IS NOT DISTINCT FROM $3 LIMIT 1', [user.userId, user.sid, seen.userAgent?.slice(0, 300) ?? null]);
        const any = await c.query('SELECT 1 FROM user_session_devices WHERE user_id = $1 AND sid <> $2 LIMIT 1', [user.userId, user.sid]);
        return (any.rowCount ?? 0) > 0 && (same.rowCount ?? 0) === 0; // the very first sign-in is not "new"
      });
      if (isNew) {
        const a = describeAgent(seen.userAgent ?? null);
        void this.onNewDevice?.(user.orgId, user.userId, [a.device, a.browser].filter(Boolean).join(' · ') || 'unknown device', [city, country].filter(Boolean).join(', ')).catch(() => undefined);
      }
    } catch {
      /* best effort: never fails a request */
    }
  }

  async view(user: AuthedUser): Promise<SecurityView> {
    const idp = this.need();
    const [creds, sessions, links, providers] = await Promise.all([idp.credentials(user.sub), idp.sessions(user.sub), idp.links(user.sub), idp.signInProviders()]);
    const devices = await withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query('SELECT sid, user_agent, ip_prefix, country, city FROM user_session_devices WHERE user_id = $1', [user.userId]);
      return new Map((r.rows as Array<{ sid: string; user_agent: string | null; ip_prefix: string | null; country: string | null; city: string | null }>).map((x) => [x.sid, x]));
    });
    const pick = (types: string[]) => creds.filter((c) => types.includes(c.type)).map(({ id, label, createdAt }) => ({ id, label, createdAt }));
    return {
      password: creds.some((c) => c.type === 'password'),
      totp: pick(['otp']),
      passkeys: pick(['webauthn-passwordless', 'webauthn']),
      sessions: sessions
        .map((s) => {
          const d = devices.get(s.id);
          return { id: s.id, current: s.id === user.sid, start: s.start, lastAccess: s.lastAccess, ...describeAgent(d?.user_agent ?? null), city: d?.city ?? null, country: d?.country ?? null, ip: d?.ip_prefix ?? null };
        })
        .sort((a, b) => Number(b.current) - Number(a.current) || String(b.lastAccess).localeCompare(String(a.lastAccess))),
      links,
      providers,
    };
  }

  async endSession(user: AuthedUser, sid: string): Promise<void> {
    const ok = await this.need().endSession(user.sub, sid);
    if (!ok) throw new ProfileError(404, 'not_found', 'no such session');
    await withTenant(this.pool, user.orgId, async (c) => {
      await c.query('DELETE FROM user_session_devices WHERE user_id = $1 AND sid = $2', [user.userId, sid]);
      await c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, 'security.session.end', sid === user.sid ? 'current' : 'other']);
    });
  }

  async endAll(user: AuthedUser): Promise<void> {
    await this.need().endAllSessions(user.sub);
    await withTenant(this.pool, user.orgId, async (c) => {
      await c.query('DELETE FROM user_session_devices WHERE user_id = $1', [user.userId]);
      await c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, 'security.session.end_all', '']);
    });
  }

  /** Removes a linked Google/Microsoft account, but never the last way to sign in. */
  async unlink(user: AuthedUser, provider: string): Promise<void> {
    const idp = this.need();
    const [creds, links] = await Promise.all([idp.credentials(user.sub), idp.links(user.sub)]);
    if (!links.some((l) => l.provider === provider)) throw new ProfileError(404, 'not_found', 'not linked');
    const otherWay = creds.some((c) => c.type === 'password' || c.type === 'webauthn-passwordless') || links.length > 1;
    if (!otherWay) throw new ProfileError(409, 'last_sign_in', 'set a password or a passkey first: this is your only way to sign in');
    await idp.unlink(user.sub, provider);
    await withTenant(this.pool, user.orgId, (c) =>
      c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, 'security.link.remove', provider]),
    );
  }
}
