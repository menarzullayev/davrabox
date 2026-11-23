import { CanActivate, Controller, ExecutionContext, ForbiddenException, Get, HttpException, Inject, Injectable, Query, Req, Res, UseGuards } from '@nestjs/common';
import { pipeline } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { Response } from 'express';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { AuditError, AuditService } from './audit.service.js';

export const AUDIT = Symbol('AUDIT');

type Req = IncomingMessage & { user: AuthedUser };

/** Runs after AuthGuard: only organization administrators may read the audit trail. */
@Injectable()
export class AuditAdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const user = ctx.switchToHttp().getRequest<Req>().user;
    if (user?.role !== 'org_admin') throw new ForbiddenException();
    return true;
  }
}

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof AuditError) throw new HttpException({ statusCode: e.status, message: e.message }, e.status, { cause: e });
    throw e;
  });
}

@Controller('v1/admin/audit')
@UseGuards(AuthGuard, AuditAdminGuard)
export class AuditController {
  constructor(@Inject(AUDIT) private readonly svc: AuditService) {}

  @Get()
  list(@Req() req: Req, @Query() q: Record<string, unknown>, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return wrap(this.svc.list(req.user, q));
  }

  @Get('verify')
  verify(@Req() req: Req, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return wrap(this.svc.verify(req.user));
  }

  @Get('export')
  async export(@Req() req: Req, @Query() q: Record<string, unknown>, @Res() res: Response) {
    let out;
    try {
      out = await this.svc.export(req.user, q['format'], q);
    } catch (e) {
      if (e instanceof AuditError) {
        for (const [k, v] of Object.entries(e.headers)) res.setHeader(k, v);
        res.setHeader('Cache-Control', 'no-store');
        res.status(e.status).json({ statusCode: e.status, message: e.message });
        return;
      }
      throw e;
    }
    res.status(200);
    res.setHeader('Content-Type', out.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    // A failure after the headers went out can only abort the connection; the client then sees a truncated download.
    pipeline(out.stream, res, (err) => {
      if (err && !res.destroyed) res.destroy(err);
    });
  }
}
