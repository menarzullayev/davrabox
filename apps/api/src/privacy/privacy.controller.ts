import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Param, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { AdminGuard } from '../admin/admin.controller.js';
import { PrivacyError, PrivacyService } from './privacy.service.js';

export const PRIVACY = Symbol('PRIVACY');

type Request = { user: AuthedUser };

const eraseSchema = z.object({ confirm: z.string().max(320) }).strict();

function parse(body: unknown): string {
  const r = eraseSchema.safeParse(body);
  if (!r.success) throw new HttpException('invalid input: confirm must be the e-mail address of the account', 400);
  return r.data.confirm;
}

async function wrap<T>(res: Response, p: Promise<T>): Promise<T> {
  res.setHeader('Cache-Control', 'no-store');
  try {
    return await p;
  } catch (e) {
    if (e instanceof PrivacyError) {
      for (const [k, v] of Object.entries(e.headers)) res.setHeader(k, v);
      throw new HttpException(e.message, e.status);
    }
    throw e;
  }
}

function attach(res: Response, userId: string): void {
  res.setHeader('Content-Disposition', `attachment; filename="davrabox-export-${userId}.json"`);
}

/** The signed-in person's own rights. Any member. */
@Controller('v1/me')
@UseGuards(AuthGuard)
export class MePrivacyController {
  constructor(@Inject(PRIVACY) private readonly svc: PrivacyService) {}

  @Get('export')
  async export(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const out = await wrap(res, this.svc.exportUser(req.user, req.user.userId));
    attach(res, req.user.userId);
    return out;
  }

  /** Body: { "confirm": "<your e-mail address>" }. */
  @Delete()
  @HttpCode(200)
  erase(@Req() req: Request, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return wrap(res, this.svc.eraseUser(req.user, req.user.userId, parse(body)));
  }
}

/** The same rights exercised by an organization admin for a member of the same organization. */
@Controller('v1/admin/users')
@UseGuards(AuthGuard, AdminGuard)
export class AdminPrivacyController {
  constructor(@Inject(PRIVACY) private readonly svc: PrivacyService) {}

  @Get(':id/export')
  async export(@Req() req: Request, @Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const out = await wrap(res, this.svc.exportUser(req.user, id));
    attach(res, id);
    return out;
  }

  /** Body: { "confirm": "<the e-mail address of the person to erase>" }. */
  @Delete(':id')
  @HttpCode(200)
  erase(@Req() req: Request, @Param('id') id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return wrap(res, this.svc.eraseUser(req.user, id, parse(body)));
  }
}
