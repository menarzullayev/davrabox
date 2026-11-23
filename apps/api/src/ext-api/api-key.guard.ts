import { CanActivate, ExecutionContext, ForbiddenException, HttpException, Inject, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiKeyScope, ApiKeysService, ApiPrincipal } from './api-keys.service.js';
import { EXT_KEYS } from './tokens.js';

export type { ApiPrincipal } from './api-keys.service.js';

const SCOPE_KEY = 'ext:scope';
/** Declares the scope a handler needs. A handler without it is denied: the external surface is closed by default. */
export const Scope = (scope: ApiKeyScope) => SetMetadata(SCOPE_KEY, scope);

/**
 * Authenticates `Authorization: Bearer dbx_...` and sets `req.apiOrg`. Wrong, unknown and revoked keys all answer
 * the same 401. The key is never logged and never accepted from the URL.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(@Inject(EXT_KEYS) private readonly keys: ApiKeysService, @Inject(Reflector) private readonly reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const http = ctx.switchToHttp();
    const req = http.getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();
    const principal = await this.keys.authenticate(header.slice(7));
    if (!principal) throw new UnauthorizedException();

    const retryAfter = await this.keys.hit(principal);
    if (retryAfter !== null) {
      http.getResponse().setHeader('Retry-After', String(retryAfter));
      throw new HttpException('rate limit exceeded', 429);
    }

    const needed = this.reflector.getAllAndOverride<ApiKeyScope | undefined>(SCOPE_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!needed || !principal.scopes.includes(needed)) throw new ForbiddenException('missing scope');
    req.apiOrg = principal satisfies ApiPrincipal;
    return true;
  }
}
