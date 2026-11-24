import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { noControl } from '../common/text.js';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { AdminGuard } from '../admin/admin.controller.js';
import { wrapExt } from './keys.controller.js';
import { EXT_WEBHOOKS } from './tokens.js';
import { DELIVERY_STATUSES, WEBHOOK_EVENTS, type WebhooksService } from './webhooks.service.js';

const createSchema = z
  .object({
    url: z.string().max(2048),
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
  })
  .strict()
  .refine((v) => new Set(v.events).size === v.events.length, 'duplicate event');

const deliveriesQuery = z
  .object({
    status: z.enum(DELIVERY_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().max(200).refine(noControl).optional(),
  })
  .strict();

type Request = { user: AuthedUser };

/** Organization admins manage webhook endpoints. The signing secret is in the creation response only. */
@Controller('v1/admin/webhooks')
@UseGuards(AuthGuard, AdminGuard)
export class WebhooksController {
  constructor(@Inject(EXT_WEBHOOKS) private readonly hooks: WebhooksService) {}

  @Post()
  create(@Req() req: Request, @Body() body: unknown) {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new HttpException('invalid input', 400);
    return wrapExt(this.hooks.create(req.user, parsed.data));
  }

  @Get()
  list(@Req() req: Request) {
    return this.hooks.list(req.user);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('id') id: string) {
    await wrapExt(this.hooks.remove(req.user, id));
  }

  /** Delivery log; `?status=dead` shows the dead letters. */
  @Get(':id/deliveries')
  deliveries(@Req() req: Request, @Param('id') id: string, @Query() query: unknown) {
    const q = deliveriesQuery.safeParse(query);
    if (!q.success) throw new HttpException('invalid query', 400);
    return wrapExt(this.hooks.deliveries(req.user, id, q.data));
  }
}
