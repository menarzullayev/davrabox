import { Body, Controller, Get, Header, HttpCode, HttpException, Inject, Optional, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { appUrlFor } from '../meetings/public-url.js';
import type { RateLimiter } from '../rate-limit/limiter.js';
import { RateLimitService } from '../rate-limit/service.js';
import { OnboardingError, OnboardingService } from './onboarding.service.js';

export const ONBOARDING = Symbol('ONBOARDING');
/** The application's public origins (CORS_ORIGINS): the verification link lands only on one of them. */
export const APP_ORIGINS = Symbol('APP_ORIGINS');

export const onboardingPatchSchema = z
  .object({ devicesTested: z.literal(true), meetingJoined: z.literal(true), dismissed: z.literal(true) })
  .partial()
  .strict();

type Req = { user: AuthedUser; headers: Record<string, string | string[] | undefined> };

const hostOf = (req: Req): string | undefined => {
  const h = req.headers['x-forwarded-host'] ?? req.headers['host'];
  return Array.isArray(h) ? h[0] : h;
};

/** The signed-in person's "Get started" checklist and the email verification link. */
@Controller('v1/me')
@UseGuards(AuthGuard)
export class OnboardingController {
  // Each send is a real email on a shared daily quota: a few per person per hour is plenty.
  private readonly sendLimiter: RateLimiter;

  constructor(
    @Inject(ONBOARDING) private readonly svc: OnboardingService,
    @Inject(APP_ORIGINS) private readonly origins: string[],
    @Optional() @Inject(RateLimitService) rate?: RateLimitService,
  ) {
    this.sendLimiter = (rate ?? RateLimitService.memory()).limiter({ name: 'verify-email', max: 3, windowMs: 60 * 60_000 });
  }

  @Get('onboarding')
  @Header('Cache-Control', 'no-store')
  get(@Req() req: Req) {
    return this.svc.get(req.user);
  }

  @Put('onboarding')
  @Header('Cache-Control', 'no-store')
  async put(@Req() req: Req, @Body() body: unknown) {
    const parsed = onboardingPatchSchema.safeParse(body);
    if (!parsed.success) throw new HttpException({ statusCode: 400, code: 'invalid_input', message: 'invalid input' }, 400);
    return this.svc.set(req.user, parsed.data);
  }

  @Post('verify-email')
  @HttpCode(202)
  async verifyEmail(@Req() req: Req) {
    const d = await this.sendLimiter.hit(req.user.userId);
    if (!d.allowed) throw new HttpException({ statusCode: 429, code: 'rate_limited', message: 'please wait before asking again', retryAfter: d.retryAfterSec }, 429);
    try {
      await this.svc.sendVerification(req.user, appUrlFor(hostOf(req), this.origins));
    } catch (e) {
      if (e instanceof OnboardingError) throw new HttpException({ statusCode: e.status, code: e.code, message: e.message }, e.status);
      throw e;
    }
    return { sent: true };
  }
}
