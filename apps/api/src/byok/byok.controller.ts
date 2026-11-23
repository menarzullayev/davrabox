import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { AdminGuard } from '../admin/admin.controller.js';
import { ByokError, ByokService } from './byok.service.js';

export const BYOK = Symbol('BYOK');

const keyName = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/);
const mount = z.string().trim().max(200).regex(/^[A-Za-z0-9_/-]{1,200}$/);
const configSchema = z
  .object({
    provider: z.literal('vault-transit').default('vault-transit'),
    addr: z.string().trim().min(1).max(2048),
    token: z.string().min(1).max(4096),
    keyName,
    mount: mount.optional(),
    namespace: z.string().trim().max(128).regex(/^[A-Za-z0-9_/-]{1,128}$/).optional(),
  })
  .strict();
const rewrapSchema = z
  .object({
    target: z.enum(['customer', 'platform']).default('customer'),
    limit: z.number().int().min(1).max(500).default(100),
    after: z.string().max(60).optional(),
  })
  .strict();

type Req = { user: AuthedUser };

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v ?? {});
  if (!r.success) throw new HttpException('invalid input', 400);
  return r.data;
}

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof ByokError) throw new HttpException(e.message, e.status);
    throw e;
  });
}

/** Customer-held encryption keys. Organization admins only; the token is accepted here and never sent back. */
@Controller('v1/admin/kms')
@UseGuards(AuthGuard, AdminGuard)
export class ByokController {
  constructor(@Inject(BYOK) private readonly svc: ByokService) {}

  @Get()
  get(@Req() req: Req) {
    return wrap(this.svc.get(req.user));
  }

  @Put()
  put(@Req() req: Req, @Body() body: unknown) {
    const { provider: _p, ...input } = parse(configSchema, body);
    return wrap(this.svc.put(req.user, input));
  }

  @Delete()
  @HttpCode(200)
  remove(@Req() req: Req) {
    return wrap(this.svc.remove(req.user));
  }

  @Post('test')
  @HttpCode(200)
  test(@Req() req: Req) {
    return wrap(this.svc.test(req.user));
  }

  @Post('rewrap')
  @HttpCode(200)
  rewrap(@Req() req: Req, @Body() body: unknown) {
    return wrap(this.svc.rewrap(req.user, parse(rewrapSchema, body)));
  }
}
