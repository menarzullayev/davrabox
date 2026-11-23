import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant.js';
import type { AuthedUser } from '../auth/auth.guard.js';
import { DEFAULT_POLICIES, loadPolicies, type OrgPolicies } from './policies.js';
import { generateTemporaryPassword, IdentityAdminError, type IdentityAdmin, type OrgRole } from './identity-admin.js';

export class AdminError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface UserItem {
  id: string;
  email: string;
  displayName: string;
  role: OrgRole;
  department: { id: string; name: string } | null;
  disabled: boolean;
  createdAt: string;
}

export interface ListUsersInput {
  search?: string;
  limit: number;
  cursor?: string;
}
export interface CreateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  role: OrgRole;
  departmentId?: string;
}
export interface UpdateUserInput {
  role?: OrgRole;
  departmentId?: string | null;
  disabled?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const NOT_CONFIGURED = 'identity provider admin access is not configured';

const USER_SELECT = `
  SELECT u.id, u.email, u.display_name, u.role, u.disabled, u.created_at, d.id AS dept_id, d.name AS dept_name,
         to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
  FROM users u LEFT JOIN departments d ON d.id = u.department_id`;

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: OrgRole;
  disabled: boolean;
  created_at: Date;
  dept_id: string | null;
  dept_name: string | null;
  cursor_ts: string;
}

function toItem(r: UserRow): UserItem {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    role: r.role,
    department: r.dept_id ? { id: r.dept_id, name: r.dept_name ?? '' } : null,
    disabled: r.disabled,
    createdAt: r.created_at.toISOString(),
  };
}

export function encodeCursor(ts: string, id: string): string {
  return Buffer.from(`${ts}|${id}`, 'utf8').toString('base64url');
}

/** Strict decoder: anything that is not exactly what encodeCursor produces is rejected (HTTP 400). */
export function decodeCursor(cursor: string): { ts: string; id: string } {
  const bad = new AdminError(400, 'invalid cursor');
  if (cursor.length > 200) throw bad;
  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const [ts, id] = parts;
  if (parts.length !== 2 || !ts || !id || !CURSOR_TS_RE.test(ts) || !UUID_RE.test(id)) throw bad;
  if (Number.isNaN(Date.parse(ts))) throw bad; // e.g. month 13 passes the shape check but is not a date
  if (encodeCursor(ts, id) !== cursor) throw bad; // non-canonical base64 (padding, junk characters) is rejected too
  return { ts, id };
}

/** Escapes LIKE wildcards so user input is matched literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export class AdminService {
  constructor(private readonly pool: Pool, private readonly idp: IdentityAdmin | null) {}

  private assertUuid(id: string, what: string): void {
    if (!UUID_RE.test(id)) throw new AdminError(404, `${what} not found`);
  }

  private audit(c: PoolClient, actor: AuthedUser, action: string, target: string) {
    return c.query('INSERT INTO audit_log (org_id, actor_id, action, target) VALUES ($1, $2, $3, $4)', [
      actor.orgId,
      actor.userId,
      action,
      target.slice(0, 500),
    ]);
  }

  /** Serializes seat-affecting changes of one organization, then fails with 409 when no seat is left. */
  private async assertSeatFree(c: PoolClient, orgId: string): Promise<void> {
    await c.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
    const lim = await c.query('SELECT seats_limit FROM org_licenses');
    const limit = lim.rows[0]?.seats_limit as number | null | undefined;
    if (limit === null || limit === undefined) return;
    const used = await c.query('SELECT count(*)::int AS n FROM users WHERE NOT disabled');
    if ((used.rows[0].n as number) >= limit) throw new AdminError(409, 'seat limit reached');
  }

  // --- overview ------------------------------------------------------------------------------------------

  async overview(actor: AuthedUser) {
    return withTenant(this.pool, actor.orgId, async (c) => {
      const org = await c.query('SELECT name, slug FROM organizations');
      const users = await c.query('SELECT count(*)::int AS n FROM users WHERE NOT disabled');
      const lim = await c.query('SELECT seats_limit FROM org_licenses');
      const meetings = await c.query("SELECT count(*)::int AS n FROM meetings WHERE created_at > now() - interval '30 days'");
      return {
        org: { name: org.rows[0].name as string, slug: org.rows[0].slug as string },
        users: users.rows[0].n as number,
        seatsLimit: (lim.rows[0]?.seats_limit ?? null) as number | null,
        meetingsLast30d: meetings.rows[0].n as number,
      };
    });
  }

  // --- users -----------------------------------------------------------------------------------------------

  async listUsers(actor: AuthedUser, input: ListUsersInput) {
    const cur = input.cursor ? decodeCursor(input.cursor) : null;
    const like = input.search ? `%${escapeLike(input.search)}%` : null;
    return withTenant(this.pool, actor.orgId, async (c) => {
      const r = await c.query(
        `${USER_SELECT}
         WHERE ($1::text IS NULL OR u.email ILIKE $1 ESCAPE '\\' OR u.display_name ILIKE $1 ESCAPE '\\')
           AND ($2::timestamptz IS NULL OR (u.created_at, u.id) < ($2::timestamptz, $3::uuid))
         ORDER BY u.created_at DESC, u.id DESC
         LIMIT $4`,
        [like, cur?.ts ?? null, cur?.id ?? null, input.limit + 1],
      );
      const rows = r.rows as UserRow[];
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map(toItem),
        next: rows.length > input.limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
      };
    });
  }

  private async userItem(c: PoolClient, id: string): Promise<UserItem> {
    const r = await c.query(`${USER_SELECT} WHERE u.id = $1`, [id]);
    if (!r.rows[0]) throw new AdminError(404, 'user not found');
    return toItem(r.rows[0] as UserRow);
  }

  async createUser(actor: AuthedUser, input: CreateUserInput): Promise<{ user: UserItem; temporaryPassword: string }> {
    if (!this.idp) throw new AdminError(503, NOT_CONFIGURED);
    const idp = this.idp;

    const requireTotp = await withTenant(this.pool, actor.orgId, async (c) => {
      if (input.departmentId) {
        const d = await c.query('SELECT 1 FROM departments WHERE id = $1', [input.departmentId]); // RLS: own org only
        if (!d.rowCount) throw new AdminError(404, 'department not found');
      }
      await this.assertSeatFree(c, actor.orgId);
      return (await loadPolicies(c)).requireTotp;
    });

    const temporaryPassword = generateTemporaryPassword();
    let sub: string;
    try {
      ({ id: sub } = await idp.createUser({
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        orgSlug: actor.orgSlug,
        role: input.role,
        requireTotp,
        temporaryPassword,
      }));
    } catch (e) {
      throw mapIdp(e);
    }

    try {
      const user = await withTenant(this.pool, actor.orgId, async (c) => {
        await this.assertSeatFree(c, actor.orgId); // re-check under the organization lock
        const ins = await c.query(
          `INSERT INTO users (org_id, external_sub, email, display_name, role, department_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [actor.orgId, sub, input.email, `${input.firstName} ${input.lastName}`.trim(), input.role, input.departmentId ?? null],
        );
        const id = ins.rows[0].id as string;
        await this.audit(c, actor, 'admin.user.create', `${id}:role=${input.role}`);
        return this.userItem(c, id);
      });
      return { user, temporaryPassword };
    } catch (e) {
      await idp.deleteUser(sub).catch(() => undefined); // keep the provider and the database consistent
      if ((e as { code?: string }).code === '23505') throw new AdminError(409, 'a user with this email already exists');
      throw e;
    }
  }

  async updateUser(actor: AuthedUser, id: string, patch: UpdateUserInput): Promise<UserItem> {
    this.assertUuid(id, 'user');
    const touchesIdp = patch.role !== undefined || patch.disabled !== undefined;
    if (touchesIdp && !this.idp) throw new AdminError(503, NOT_CONFIGURED);

    return withTenant(this.pool, actor.orgId, async (c) => {
      const cur = await c.query('SELECT id, role, disabled, external_sub, department_id FROM users WHERE id = $1 FOR UPDATE', [id]);
      const target = cur.rows[0] as
        | { id: string; role: OrgRole; disabled: boolean; external_sub: string; department_id: string | null }
        | undefined;
      if (!target) throw new AdminError(404, 'user not found'); // RLS hides other organizations' rows

      const roleChange = patch.role !== undefined && patch.role !== target.role ? patch.role : undefined;
      const disabledChange = patch.disabled !== undefined && patch.disabled !== target.disabled ? patch.disabled : undefined;

      if (target.id === actor.userId && (roleChange === 'member' || disabledChange === true)) {
        throw new AdminError(400, 'you cannot demote or disable yourself');
      }
      if (target.role === 'org_admin' && !target.disabled && (roleChange === 'member' || disabledChange === true)) {
        const others = await c.query("SELECT id FROM users WHERE role = 'org_admin' AND NOT disabled AND id <> $1 FOR UPDATE", [id]);
        if (!others.rowCount) throw new AdminError(409, 'the last organization admin cannot be demoted or disabled');
      }
      if (patch.departmentId) {
        const d = await c.query('SELECT 1 FROM departments WHERE id = $1', [patch.departmentId]); // RLS: own org only
        if (!d.rowCount) throw new AdminError(404, 'department not found');
      }
      if (disabledChange === false) await this.assertSeatFree(c, actor.orgId);

      if ((roleChange !== undefined || disabledChange !== undefined) && this.idp) {
        try {
          await this.idp.updateUser(target.external_sub, actor.orgSlug, {
            ...(roleChange !== undefined ? { role: roleChange } : {}),
            ...(disabledChange !== undefined ? { enabled: !disabledChange } : {}),
          });
        } catch (e) {
          throw mapIdp(e);
        }
      }

      const sets: string[] = [];
      const vals: unknown[] = [];
      const add = (col: string, v: unknown) => {
        vals.push(v);
        sets.push(`${col} = $${vals.length}`);
      };
      if (roleChange !== undefined) add('role', roleChange);
      if (disabledChange !== undefined) add('disabled', disabledChange);
      if (patch.departmentId !== undefined) add('department_id', patch.departmentId);
      if (sets.length) {
        vals.push(id);
        try {
          await c.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
        } catch (e) {
          if ((e as { code?: string }).code === '23503') throw new AdminError(404, 'department not found');
          throw e;
        }
      }

      const changes = [
        roleChange !== undefined ? `role=${roleChange}` : null,
        disabledChange !== undefined ? `disabled=${disabledChange}` : null,
        patch.departmentId !== undefined ? `department=${patch.departmentId ?? 'none'}` : null,
      ].filter(Boolean);
      await this.audit(c, actor, disabledChange === true ? 'admin.user.disable' : 'admin.user.update', `${id}:${changes.join(',')}`);
      return this.userItem(c, id);
    });
  }

  // --- departments -----------------------------------------------------------------------------------------

  async listDepartments(actor: AuthedUser) {
    return withTenant(this.pool, actor.orgId, async (c) => {
      const r = await c.query(
        `SELECT d.id, d.name, count(u.id)::int AS user_count
         FROM departments d LEFT JOIN users u ON u.department_id = d.id
         GROUP BY d.id ORDER BY lower(d.name), d.id`,
      );
      return r.rows.map((x: { id: string; name: string; user_count: number }) => ({ id: x.id, name: x.name, userCount: x.user_count }));
    });
  }

  async createDepartment(actor: AuthedUser, name: string) {
    return withTenant(this.pool, actor.orgId, async (c) => {
      try {
        const r = await c.query('INSERT INTO departments (org_id, name) VALUES ($1, $2) RETURNING id, name', [actor.orgId, name]);
        await this.audit(c, actor, 'admin.department.create', r.rows[0].id);
        return { id: r.rows[0].id as string, name: r.rows[0].name as string, userCount: 0 };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new AdminError(409, 'a department with this name already exists');
        throw e;
      }
    });
  }

  async renameDepartment(actor: AuthedUser, id: string, name: string) {
    this.assertUuid(id, 'department');
    return withTenant(this.pool, actor.orgId, async (c) => {
      try {
        const r = await c.query('UPDATE departments SET name = $1 WHERE id = $2 RETURNING id, name', [name, id]);
        if (!r.rowCount) throw new AdminError(404, 'department not found');
        await this.audit(c, actor, 'admin.department.update', id);
        const n = await c.query('SELECT count(*)::int AS n FROM users WHERE department_id = $1', [id]);
        return { id, name: r.rows[0].name as string, userCount: n.rows[0].n as number };
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw new AdminError(409, 'a department with this name already exists');
        throw e;
      }
    });
  }

  async deleteDepartment(actor: AuthedUser, id: string) {
    this.assertUuid(id, 'department');
    return withTenant(this.pool, actor.orgId, async (c) => {
      const lock = await c.query('SELECT id FROM departments WHERE id = $1 FOR UPDATE', [id]);
      if (!lock.rowCount) throw new AdminError(404, 'department not found');
      const n = await c.query('SELECT count(*)::int AS n FROM users WHERE department_id = $1', [id]);
      if ((n.rows[0].n as number) > 0) throw new AdminError(409, 'the department still has users');
      await c.query('DELETE FROM departments WHERE id = $1', [id]);
      await this.audit(c, actor, 'admin.department.delete', id);
      return { deleted: true, id };
    });
  }

  // --- policies --------------------------------------------------------------------------------------------

  async getPolicies(actor: AuthedUser): Promise<OrgPolicies> {
    return withTenant(this.pool, actor.orgId, (c) => loadPolicies(c));
  }

  async setPolicies(actor: AuthedUser, p: OrgPolicies): Promise<OrgPolicies> {
    return withTenant(this.pool, actor.orgId, async (c) => {
      await c.query(
        `INSERT INTO org_policies (org_id, require_passcode, waiting_room_default, max_participants, require_totp)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id) DO UPDATE SET require_passcode = EXCLUDED.require_passcode,
           waiting_room_default = EXCLUDED.waiting_room_default, max_participants = EXCLUDED.max_participants,
           require_totp = EXCLUDED.require_totp, updated_at = now()`,
        [actor.orgId, p.requirePasscode, p.waitingRoomDefault, p.maxParticipants, p.requireTotp],
      );
      await this.audit(
        c,
        actor,
        'admin.policy.update',
        `requirePasscode=${p.requirePasscode},waitingRoomDefault=${p.waitingRoomDefault},maxParticipants=${p.maxParticipants},requireTotp=${p.requireTotp}`,
      );
      return { ...DEFAULT_POLICIES, ...p };
    });
  }
}

function mapIdp(e: unknown): unknown {
  if (e instanceof IdentityAdminError) return new AdminError(e.status, e.message);
  return e;
}
