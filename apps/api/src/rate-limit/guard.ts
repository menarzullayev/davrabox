import { CallHandler, CanActivate, ExecutionContext, HttpException, Inject, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { RateLimitService } from './service.js';

const SKIP = 'davra:skip-rate-limit';

/** Exempts a route or controller from the GLOBAL ceilings (liveness/readiness probes, the media server's webhook). */
export const SkipRateLimit = () => SetMetadata(SKIP, true);

interface Res {
  setHeader(name: string, value: string): void;
}

/** 429 with a Retry-After header (whole seconds) and a body that says nothing about the limiter's internals. */
export function tooManyRequests(res: Res, retryAfterSec: number, message = 'too many requests, please try again later'): HttpException {
  res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterSec))));
  return new HttpException({ statusCode: 429, message }, 429);
}

/**
 * Global guard, runs before authentication: (1) addresses that produced too many failed authentications are refused
 * before any token is verified; (2) the per-IP ceiling on every request.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(@Inject(RateLimitService) private readonly rate: RateLimitService, @Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http' || !this.rate.cfg.RATE_LIMIT_ENABLED) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP, [ctx.getHandler(), ctx.getClass()])) return true;
    const http = ctx.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse<Res>();
    const key = this.rate.clientKey(req);
    const failed = await this.rate.authFailures.check(key);
    if (!failed.allowed) throw tooManyRequests(res, failed.retryAfterSec);
    const d = await this.rate.ipCeiling.hit(key);
    if (!d.allowed) throw tooManyRequests(res, d.retryAfterSec);
    return true;
  }
}

/** Global interceptor (runs after the auth guard, so the user is known): the per-user ceiling. */
@Injectable()
export class UserRateLimitInterceptor implements NestInterceptor {
  constructor(@Inject(RateLimitService) private readonly rate: RateLimitService, @Inject(Reflector) private readonly reflector: Reflector) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (ctx.getType() === 'http' && this.rate.cfg.RATE_LIMIT_ENABLED && !this.reflector.getAllAndOverride<boolean>(SKIP, [ctx.getHandler(), ctx.getClass()])) {
      const http = ctx.switchToHttp();
      const user = http.getRequest().user as { userId?: string } | undefined;
      if (user?.userId) {
        const d = await this.rate.userCeiling.hit(user.userId);
        if (!d.allowed) throw tooManyRequests(http.getResponse<Res>(), d.retryAfterSec);
      }
    }
    return next.handle();
  }
}
