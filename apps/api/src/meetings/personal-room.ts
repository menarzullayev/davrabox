import argon2 from 'argon2';
import type { Pool, PoolClient } from 'pg';
import type { AuthedUser } from '../auth/auth.guard.js';
import { loadPolicies, type OrgPolicies } from '../admin/policies.js';
import { withTenant } from '../db/tenant.js';
import type { GuestMode } from './guest-types.js';
import { MeetingError, newCode } from './meetings.service.js';

/** The person's own room as the home screen shows it. The passcode itself is never returned (only a hash is stored). */
export interface PersonalRoom {
  code: string;
  title: string;
  waitingRoom: boolean;
  hasPasscode: boolean;
  /** The room's guest setting; joins are capped by the organization's policy at every join anyway. */
  guests: GuestMode;
}

export interface PersonalRoomView {
  room: PersonalRoom | null;
  /** What the organization requires/allows, so the form shows only the choices that can be saved. */
  policy: { requirePasscode: boolean; guestPolicy: GuestMode };
}

export interface PersonalRoomPatch {
  /** A new passcode, or null to remove it (refused when the organization requires one). */
  passcode?: string | null;
  waitingRoom?: boolean;
  guests?: GuestMode;
}

const RANK: Record<GuestMode, number> = { off: 0, waiting_room: 1, open: 2 };

interface Row {
  id: string;
  code: string;
  title: string;
  waiting_room: boolean;
  has_passcode: boolean;
  guest_mode: GuestMode;
}

const view = (r: Row): PersonalRoom => ({ code: r.code, title: r.title, waitingRoom: r.waiting_room, hasPasscode: r.has_passcode, guests: r.guest_mode });

/**
 * Personal room per member (owner decision 3): a fixed link and number, waiting room on by default, optional passcode,
 * "regenerate link" (the old code stops working at once), and the organization's guest policy applies. It is an ordinary
 * meeting row, so join, waiting room, passcode checks, bans and guest joins are the same code paths as for any meeting.
 */
export class PersonalRoomService {
  constructor(private readonly pool: Pool) {}

  async get(user: AuthedUser): Promise<PersonalRoomView> {
    return withTenant(this.pool, user.orgId, async (c) => {
      const policy = await loadPolicies(c);
      const row = await this.row(c, user.userId);
      return { room: row ? view(row) : null, policy: { requirePasscode: policy.requirePasscode, guestPolicy: policy.guestPolicy } };
    });
  }

  /** Creates the room the first time (idempotent: an existing room is returned unchanged). */
  async ensure(user: AuthedUser, input: { title: string; passcode?: string }): Promise<PersonalRoom> {
    const existing = await withTenant(this.pool, user.orgId, (c) => this.row(c, user.userId));
    if (existing) return view(existing);
    const policy = await withTenant(this.pool, user.orgId, (c) => loadPolicies(c));
    if (policy.requirePasscode && !input.passcode) throw new MeetingError(400, 'this organization requires a meeting passcode');
    const hash = input.passcode ? await argon2.hash(input.passcode, { type: argon2.argon2id }) : null;
    // Guests wait in the lobby by default when the organization lets guests in at all.
    const guests: GuestMode = RANK[policy.guestPolicy] >= RANK.waiting_room ? 'waiting_room' : 'off';
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await withTenant(this.pool, user.orgId, async (c) => {
          await c.query(
            `INSERT INTO meetings (org_id, code, title, host_user_id, passcode_hash, waiting_room, guest_mode, personal_owner)
             VALUES ($1, $2, $3, $4, $5, true, $6, $4)`,
            [user.orgId, newCode(), input.title, user.userId, hash, guests],
          );
          await this.audit(c, user, 'meeting.personal.create', '');
          return view((await this.row(c, user.userId))!);
        });
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        if (e.code === '23505' && e.constraint === 'meetings_personal_owner_uq') {
          // Two tabs created it at the same time: the other one won.
          return view((await withTenant(this.pool, user.orgId, (c) => this.row(c, user.userId)))!);
        }
        if (e.code === '23505') continue; // code collision, retry
        throw err;
      }
    }
    throw new MeetingError(503, 'could not allocate a meeting code');
  }

  async update(user: AuthedUser, patch: PersonalRoomPatch): Promise<PersonalRoom> {
    const hash = typeof patch.passcode === 'string' ? await argon2.hash(patch.passcode, { type: argon2.argon2id }) : undefined;
    return withTenant(this.pool, user.orgId, async (c) => {
      const row = await this.row(c, user.userId);
      if (!row) throw new MeetingError(404, 'no personal room yet');
      const policy: OrgPolicies = await loadPolicies(c);
      if (patch.passcode === null && policy.requirePasscode) throw new MeetingError(400, 'this organization requires a meeting passcode');
      if (patch.guests && RANK[patch.guests] > RANK[policy.guestPolicy]) throw new MeetingError(400, 'this organization does not allow that guest setting');
      const sets: string[] = [];
      const args: unknown[] = [row.id];
      if (patch.passcode !== undefined) {
        args.push(hash ?? null);
        sets.push(`passcode_hash = $${args.length}`);
      }
      if (patch.waitingRoom !== undefined) {
        args.push(patch.waitingRoom);
        sets.push(`waiting_room = $${args.length}`);
      }
      if (patch.guests !== undefined) {
        args.push(patch.guests);
        sets.push(`guest_mode = $${args.length}`);
      }
      if (sets.length) {
        await c.query(`UPDATE meetings SET ${sets.join(', ')} WHERE id = $1`, args);
        const what = [patch.passcode === undefined ? '' : patch.passcode === null ? 'passcode=off' : 'passcode=on', patch.waitingRoom === undefined ? '' : `waiting_room=${patch.waitingRoom}`, patch.guests ? `guests=${patch.guests}` : '']
          .filter(Boolean)
          .join(',');
        await this.audit(c, user, 'meeting.personal.update', `${row.code}:${what}`);
      }
      return view((await this.row(c, user.userId))!);
    });
  }

  /** A new number and link; the old code stops resolving at once. People already in the call stay connected. */
  async regenerate(user: AuthedUser): Promise<PersonalRoom> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await withTenant(this.pool, user.orgId, async (c) => {
          const row = await this.row(c, user.userId);
          if (!row) throw new MeetingError(404, 'no personal room yet');
          const code = newCode();
          await c.query('UPDATE meetings SET code = $2 WHERE id = $1', [row.id, code]);
          // Waiting requests for the old link are void: whoever wants in needs the new link.
          // (members' requests are removed, not denied: a member who gets the new link must be able to ask again)
          await c.query("DELETE FROM join_requests WHERE meeting_id = $1 AND status = 'pending'", [row.id]);
          await c.query("UPDATE guest_sessions SET status = 'denied', decided_at = now(), decided_by = $2 WHERE meeting_id = $1 AND status = 'pending'", [row.id, user.userId]);
          await this.audit(c, user, 'meeting.personal.regenerate', `${row.code}->${code}`);
          return view((await this.row(c, user.userId))!);
        });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') continue;
        throw err;
      }
    }
    throw new MeetingError(503, 'could not allocate a meeting code');
  }

  private async row(c: PoolClient, userId: string): Promise<Row | null> {
    const r = await c.query(
      `SELECT id, code, title, waiting_room, (passcode_hash IS NOT NULL) AS has_passcode, guest_mode FROM meetings WHERE personal_owner = $1`,
      [userId],
    );
    return (r.rows[0] as Row | undefined) ?? null;
  }

  private audit(c: PoolClient, user: AuthedUser, action: string, target: string) {
    return c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [user.orgId, user.userId, action, target]);
  }
}
