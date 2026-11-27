import { Body, Controller, Get, Headers, HttpCode, HttpException, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { noControl } from '../common/text.js';
import { RateLimitService } from '../rate-limit/service.js';
import { GuestService } from './guest.service.js';
import { MeetingError } from './meetings.service.js';
import { countryOf } from './meetings.controller.js';

export const GUESTS = Symbol('GUESTS');

const joinSchema = z
  .object({
    name: z.string().max(120),
    passcode: z.string().max(64).refine(noControl).optional(),
    acceptDisclaimer: z.literal(true).optional(),
  })
  .strict();

type Req = { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } };

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof MeetingError) throw new HttpException(e.extra ? { statusCode: e.status, message: e.message, ...e.extra } : e.message, e.status);
    throw e;
  });
}

function hostOf(req: Req): string | undefined {
  const fwd = req.headers['x-forwarded-host'];
  return (Array.isArray(fwd) ? fwd[0] : fwd) ?? (req.headers['host'] as string | undefined);
}

/**
 * Public entry for people without an account. No AuthGuard: what protects it is the per-address limits in GuestService,
 * the global per-address ceiling, the organization's guest policy and the host's waiting room.
 */
@Controller('v1/guest')
export class GuestController {
  constructor(
    @Inject(GUESTS) private readonly svc: GuestService,
    @Inject(RateLimitService) private readonly rate: RateLimitService,
  ) {}

  @Post('meetings/:code/join')
  @HttpCode(200)
  join(@Req() req: Req, @Param('code') code: string, @Body() body: unknown) {
    const parsed = joinSchema.safeParse(body);
    if (!parsed.success) throw new HttpException('invalid input', 400);
    return wrap(
      this.svc.join(
        { code, name: parsed.data.name, passcode: parsed.data.passcode, acceptDisclaimer: parsed.data.acceptDisclaimer === true },
        { ipKey: this.rate.clientKey(req), requestHost: hostOf(req), country: countryOf(req) },
      ),
    );
  }

  /** The waiting guest polls this with the guest session token it was given; an admission answers with the join token. */
  @Get('requests/:id')
  requestStatus(@Req() req: Req, @Param('id') id: string, @Headers('authorization') authorization?: string) {
    if (!authorization?.startsWith('Bearer ')) throw new HttpException('unauthorized', 401);
    return wrap(this.svc.requestStatus(authorization.slice(7), id, { ipKey: this.rate.clientKey(req), requestHost: hostOf(req) }));
  }
}
