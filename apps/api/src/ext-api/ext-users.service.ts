import type { Pool } from 'pg';
import { withTenant } from '../db/tenant.js';
import { encodeCursor } from '../admin/admin.service.js';
import type { ApiPrincipal } from './api-keys.service.js';
import { decodeExtCursor } from './ext-meetings.service.js';
import type { ListQuery, UserItem } from './ext-schemas.js';

interface Row {
  id: string;
  email: string;
  display_name: string;
  role: 'org_admin' | 'member';
  disabled: boolean;
  created_at: Date;
  cursor_ts: string;
}

export class ExtUsersService {
  constructor(private readonly pool: Pool) {}

  /** Read-only directory of the key's organization: no tokens, no external subject ids. */
  async list(p: ApiPrincipal, q: ListQuery): Promise<{ items: UserItem[]; next: string | null }> {
    const cur = q.cursor ? decodeExtCursor(q.cursor) : null;
    return withTenant(this.pool, p.orgId, async (c) => {
      const r = await c.query(
        `SELECT u.id, u.email, u.display_name, u.role, u.disabled, u.created_at,
                to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
           FROM users u
          WHERE ($1::timestamptz IS NULL OR (u.created_at, u.id) < ($1::timestamptz, $2::uuid))
          ORDER BY u.created_at DESC, u.id DESC
          LIMIT $3`,
        [cur?.ts ?? null, cur?.id ?? null, q.limit + 1],
      );
      const rows = r.rows as Row[];
      const page = rows.slice(0, q.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((u) => ({ id: u.id, email: u.email, displayName: u.display_name, role: u.role, disabled: u.disabled, createdAt: u.created_at.toISOString() })),
        next: rows.length > q.limit && last ? encodeCursor(last.cursor_ts, last.id) : null,
      };
    });
  }
}
