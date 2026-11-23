import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
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
    const { rows } = await this.pool.query(
      'SELECT org_id, user_id, role FROM provision_user($1, $2, $3, $4, $5, $6)',
      [identity.orgSlug, orgName, identity.sub, identity.email, identity.name, identity.role],
    );
    const row = rows[0];
    req.user = { ...identity, role: row.role, orgId: row.org_id, userId: row.user_id } satisfies AuthedUser;
    return true;
  }
}
