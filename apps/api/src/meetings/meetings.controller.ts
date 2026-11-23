import { Body, Controller, Get, HttpException, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { MeetingError, MeetingsService } from './meetings.service.js';

export const MEETINGS = Symbol('MEETINGS');

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  passcode: z.string().min(6).max(64).optional(),
  scheduledAt: z.string().datetime().optional(),
});
const joinSchema = z.object({ passcode: z.string().max(64).optional() });

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof MeetingError) throw new HttpException(e.message, e.status);
    throw e;
  });
}

@Controller('v1/meetings')
@UseGuards(AuthGuard)
export class MeetingsController {
  constructor(@Inject(MEETINGS) private readonly svc: MeetingsService) {}

  @Get()
  list(@Req() req: { user: AuthedUser }) {
    return this.svc.list(req.user);
  }

  @Post()
  create(@Req() req: { user: AuthedUser }, @Body() body: unknown) {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new HttpException('invalid input', 400);
    return wrap(this.svc.create(req.user, parsed.data));
  }

  @Post(':code/join')
  join(@Req() req: { user: AuthedUser; headers: Record<string, string | string[] | undefined> }, @Param('code') code: string, @Body() body: unknown) {
    const parsed = joinSchema.safeParse(body ?? {});
    if (!parsed.success) throw new HttpException('invalid input', 400);
    const fwd = req.headers['x-forwarded-host'];
    const host = (Array.isArray(fwd) ? fwd[0] : fwd) ?? (req.headers['host'] as string | undefined);
    return wrap(this.svc.join(req.user, code, parsed.data.passcode, host));
  }
}
