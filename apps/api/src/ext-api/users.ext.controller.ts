import { Controller, Get, HttpException, Inject, Query, Req, UseGuards } from '@nestjs/common';
import type { ApiPrincipal } from './api-keys.service.js';
import { ApiKeyGuard, Scope } from './api-key.guard.js';
import { listQuerySchema } from './ext-schemas.js';
import type { ExtUsersService } from './ext-users.service.js';
import { wrapExt } from './keys.controller.js';
import { EXT_USERS } from './tokens.js';

@Controller('v1/ext/users')
@UseGuards(ApiKeyGuard)
export class UsersExtController {
  constructor(@Inject(EXT_USERS) private readonly users: ExtUsersService) {}

  @Get()
  @Scope('users:read')
  list(@Req() req: { apiOrg: ApiPrincipal }, @Query() query: unknown) {
    const q = listQuerySchema.safeParse(query);
    if (!q.success) throw new HttpException('invalid query', 400);
    return wrapExt(this.users.list(req.apiOrg, q.data));
  }
}
