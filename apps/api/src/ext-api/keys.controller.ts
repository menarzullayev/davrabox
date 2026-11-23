import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { AdminGuard } from '../admin/admin.controller.js';
import { API_KEY_SCOPES, type ApiKeysService } from './api-keys.service.js';
import { ExtError } from './ext-config.js';
import { EXT_KEYS } from './tokens.js';

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(z.enum(API_KEY_SCOPES)).min(1).max(API_KEY_SCOPES.length),
  })
  .strict()
  .refine((v) => new Set(v.scopes).size === v.scopes.length, 'duplicate scope');

type Request = { user: AuthedUser };

export function wrapExt<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof ExtError) throw new HttpException(e.message, e.status);
    throw e;
  });
}

/** Organization admins manage API keys. The secret is in the creation response only. */
@Controller('v1/admin/api-keys')
@UseGuards(AuthGuard, AdminGuard)
export class KeysController {
  constructor(@Inject(EXT_KEYS) private readonly keys: ApiKeysService) {}

  @Post()
  create(@Req() req: Request, @Body() body: unknown) {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new HttpException('invalid input', 400);
    return wrapExt(this.keys.create(req.user, parsed.data));
  }

  @Get()
  list(@Req() req: Request) {
    return this.keys.list(req.user);
  }

  @Delete(':id')
  @HttpCode(204)
  async revoke(@Req() req: Request, @Param('id') id: string) {
    await wrapExt(this.keys.revoke(req.user, id));
  }
}
