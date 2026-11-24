import { Body, Controller, HttpCode, HttpException, Inject, Optional, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import type { RateLimiter } from '../rate-limit/limiter.js';
import { RateLimitService } from '../rate-limit/service.js';
import { clientIp } from './limits.js';
import { SignupError, SignupService } from './signup.service.js';

export const SIGNUP = Symbol('SIGNUP');

const noControl = (s: string) => !/[\u0000-\u001f\u007f]/.test(s);

const signupSchema = z
  .object({
    orgName: z.string().trim().min(2).max(80).refine(noControl),
    name: z.string().trim().min(1).max(80).refine(noControl),
    email: z.string().trim().max(254).pipe(z.email()),
    password: z.string().min(12).max(128),
    altcha: z.string().min(1).max(2000),
  })
  .strict()
  // Keycloak's realm policy refuses a password equal to the username (the email); refuse it before a captcha is spent.
  .refine((v) => v.password.toLowerCase() !== v.email.toLowerCase(), { path: ['password'] });

type Req = { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } };

function fail(res: Response, status: number, code: string, message: string, retryAfter?: number): never {
  if (retryAfter) res.setHeader('Retry-After', String(retryAfter));
  throw new HttpException({ statusCode: status, code, message }, status);
}

/**
 * Public (unauthenticated) trial sign-up. Responses never carry stack traces or provider detail: only a stable `code`
 * and a short English message. Nothing here is cacheable.
 */
@Controller('v1/public')
export class SignupController {
  // Issuing a challenge is cheap but unauthenticated: cap it per address. Shared between API instances when REDIS_URL is
  // set; during a Redis outage it keeps counting in memory (fail-closed to a local limit, never to unlimited).
  private readonly challengeLimiter: RateLimiter;
  // Cheap guard in front of the database for malformed floods; the real, database-backed limits live in signup_admit().
  private readonly requestLimiter: RateLimiter;

  constructor(@Inject(SIGNUP) private readonly svc: SignupService, @Optional() @Inject(RateLimitService) rate?: RateLimitService) {
    const r = rate ?? RateLimitService.memory();
    this.challengeLimiter = r.limiter({ name: 'signup-challenge', max: 60, windowMs: 60_000 });
    this.requestLimiter = r.limiter({ name: 'signup-request', max: 30, windowMs: 60_000 });
  }

  @Post('challenge')
  @HttpCode(200)
  async challenge(@Req() req: Req, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const d = await this.challengeLimiter.hit(clientIp(req, this.svc.settings.trustedProxyHops));
    if (!d.allowed) fail(res, 429, 'rate_limited', 'too many requests, please try again later', d.retryAfterSec);
    return this.svc.challenge();
  }

  @Post('signup')
  @HttpCode(201)
  async signup(@Req() req: Req, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const ip = clientIp(req, this.svc.settings.trustedProxyHops);
    const d = await this.requestLimiter.hit(ip);
    if (!d.allowed) fail(res, 429, 'rate_limited', 'too many requests, please try again later', d.retryAfterSec);
    const parsed = signupSchema.safeParse(body);
    if (!parsed.success) fail(res, 400, 'invalid_input', 'the form data is not valid');
    try {
      return await this.svc.signup(parsed.data, ip);
    } catch (e) {
      if (e instanceof SignupError) fail(res, e.status, e.code, e.message, e.retryAfter);
      throw e;
    }
  }
}
