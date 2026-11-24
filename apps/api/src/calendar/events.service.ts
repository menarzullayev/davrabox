import type { Pool } from 'pg';
import { z } from 'zod';
import { withTenant } from '../db/tenant.js';
import type { RateLimiter } from '../rate-limit/limiter.js';
import { RateLimitService } from '../rate-limit/service.js';
import type { AuthedUser } from '../auth/auth.guard.js';
import { MeetingError } from '../meetings/meetings.service.js';
import type { CalendarConfig } from './config.js';
import { CalendarOAuthService } from './oauth.service.js';
import { google } from './providers/google.js';
import { microsoft } from './providers/microsoft.js';
import { ProviderHttpError, PROVIDERS, type CalendarEventInput, type ProviderDef } from './providers/types.js';

const CODE_RE = /^[0-9]{11,12}$/;
const MAX_EVENT_MS = 12 * 3600_000;
const DEFS: Record<string, ProviderDef> = { google, microsoft };

const instant = z.string().datetime({ offset: true });
export const eventInputSchema = z
  .object({
    provider: z.enum(PROVIDERS as unknown as [string, ...string[]]),
    start: instant,
    end: instant,
    attendees: z.array(z.string().trim().email().max(254)).max(50).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const s = Date.parse(v.start);
    const e = Date.parse(v.end);
    if (!(e > s)) ctx.addIssue({ code: 'custom', path: ['end'], message: 'end must be after start' });
    else if (e - s > MAX_EVENT_MS) ctx.addIssue({ code: 'custom', path: ['end'], message: 'an event can last at most 12 hours' });
  });

export interface CreateEventResult {
  eventUrl: string;
}

/**
 * Creates a calendar event for a meeting, holding the join link and code. The provider sends the invitations to any
 * attendees (Google with sendUpdates=all, Microsoft Graph automatically); this product never emails anybody.
 */
export class CalendarEventsService {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly pool: Pool,
    private readonly oauth: CalendarOAuthService,
    private readonly cfg: CalendarConfig,
    rate: RateLimitService = RateLimitService.memory(),
  ) {
    this.limiter = rate.limiter({ name: 'calevent', max: 30, windowMs: 60_000 });
  }

  async createEvent(user: AuthedUser, code: string, rawInput: unknown): Promise<CreateEventResult> {
    const parsed = eventInputSchema.safeParse(rawInput);
    if (!parsed.success) throw new MeetingError(400, 'invalid input');
    const input = parsed.data;
    const { provider } = this.oauth.requireProvider(input.provider);
    const def = DEFS[provider]!;

    if (!CODE_RE.test(code)) throw new MeetingError(404, 'meeting not found');
    const meeting = await withTenant(this.pool, user.orgId, async (c) => {
      const r = await c.query('SELECT id, title, host_user_id, (passcode_hash IS NOT NULL) AS has_passcode FROM meetings WHERE code = $1', [code]);
      return r.rows[0] as { id: string; title: string; host_user_id: string; has_passcode: boolean } | undefined;
    });
    if (!meeting) throw new MeetingError(404, 'meeting not found');
    if (meeting.host_user_id !== user.userId) throw new MeetingError(403, 'only the host can add this meeting to a calendar');
    if (!(await this.limiter.hit(user.userId)).allowed) throw new MeetingError(429, 'too many requests, try again in a minute'); // counts every attempt

    const base = this.cfg.CALENDAR_PUBLIC_URL!.replace(/\/+$/, ''); // present: requireProvider checked it
    const joinUrl = `${base}/app?join=${encodeURIComponent(code)}`;
    const lines = [`Join the meeting: ${joinUrl}`, `Meeting code: ${code}`];
    if (meeting.has_passcode) lines.push('This meeting is protected by a passcode: ask the host for it.');
    const ev: CalendarEventInput = {
      title: meeting.title,
      startIso: new Date(input.start).toISOString(),
      endIso: new Date(input.end).toISOString(),
      description: lines.join('\n'),
      joinUrl,
      attendees: [...new Set(input.attendees ?? [])],
    };

    const eventUrl = await this.withProvider(user, provider, def, ev);
    await withTenant(this.pool, user.orgId, (c) =>
      c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, 'calendar.event.create', `${code}:${provider}`]),
    );
    return { eventUrl };
  }

  /** Calls the provider; a 401 triggers one forced token refresh and one retry, nothing more. */
  private async withProvider(user: AuthedUser, provider: string, def: ProviderDef, ev: CalendarEventInput): Promise<string> {
    const fetchFn = this.oauth.fetchFn;
    let token = await this.oauth.accessToken(user, provider);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await def.createEvent(fetchFn, token, ev);
      } catch (e) {
        if (e instanceof ProviderHttpError && e.status === 401 && attempt === 0) {
          token = await this.oauth.accessToken(user, provider, true);
          continue;
        }
        if (e instanceof ProviderHttpError) {
          // The provider's body is never forwarded; it can carry details about the user's account.
          throw new MeetingError(502, 'calendar provider refused the event');
        }
        throw new MeetingError(502, 'calendar provider is unreachable, try again');
      }
    }
    throw new MeetingError(502, 'calendar provider refused the event');
  }
}
