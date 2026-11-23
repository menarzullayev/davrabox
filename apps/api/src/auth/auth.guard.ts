import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Pool } from 'pg';
import type { Identity } from './jwt.js';

export const VERIFIER = Symbol('VERIFIER');
export const POOL = Symbol('POOL');

export interface AuthedUser extends Identity {
  orgId: string;
  userId: string;
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(VERIFIER) private readonly verify: (t: string) => Promise<Identity>,
    @Inject(POOL) private readonly pool: Pool,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    let identity: Identity;
    try {
      identity = await this.verify(header.slice(7));
    } catch {
      throw new UnauthorizedException();
    }
    const orgName = identity.orgSlug;
    let row: { org_id: string; user_id: string; role: 'org_admin' | 'member'; disabled: boolean } | undefined;
    try {
      const res = await this.pool.query(
        'SELECT org_id, user_id, role, disabled FROM provision_user($1, $2, $3, $4, $5, $6)',
        [identity.orgSlug, orgName, identity.sub, identity.email, identity.name, identity.role],
      );
      row = res.rows[0];
    } catch (e) {
      // 53400: the organization has used all licensed seats and this would be a new user.
      if ((e as { code?: string }).code === '53400') throw new ForbiddenException('seat limit reached');
      // DB001: the organization was a trial that has been purged; its slug is retired for good.
      if ((e as { code?: string }).code === 'DB001') throw new ForbiddenException('organization closed');
      throw e;
    }
    if (!row) throw new UnauthorizedException();
    if (row.disabled) throw new ForbiddenException('account is disabled');
    req.user = { ...identity, role: row.role, orgId: row.org_id, userId: row.user_id } satisfies AuthedUser;
    return true;
  }
}
