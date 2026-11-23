import { Body, Controller, HttpCode, HttpException, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { WindowLimiter } from '../audit/audit.service.js';
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
  // Issuing a challenge is cheap but unauthenticated: cap it per address (in memory is enough, it writes nothing).
  private readonly challengeLimiter = new WindowLimiter(60, 60_000);
  // Cheap guard in front of the database for malformed floods; real limits live in signup_admit().
  private readonly requestLimiter = new WindowLimiter(30, 60_000);

  constructor(@Inject(SIGNUP) private readonly svc: SignupService) {}

  @Post('challenge')
  @HttpCode(200)
  challenge(@Req() req: Req, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const wait = this.challengeLimiter.hit(clientIp(req, this.svc.settings.trustedProxyHops));
    if (wait > 0) fail(res, 429, 'rate_limited', 'too many requests, please try again later', Math.ceil(wait / 1000));
    return this.svc.challenge();
  }

  @Post('signup')
  @HttpCode(201)
  async signup(@Req() req: Req, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const ip = clientIp(req, this.svc.settings.trustedProxyHops);
    const wait = this.requestLimiter.hit(ip);
    if (wait > 0) fail(res, 429, 'rate_limited', 'too many requests, please try again later', Math.ceil(wait / 1000));
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
