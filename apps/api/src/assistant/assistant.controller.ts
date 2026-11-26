import { Body, CanActivate, Controller, Delete, ExecutionContext, ForbiddenException, Get, HttpCode, HttpException, Inject, Injectable, NotFoundException, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthGuard, VERIFIER, type AuthedUser } from '../auth/auth.guard.js';
import type { Identity } from '../auth/jwt.js';
import { clientIp } from '../rate-limit/client-ip.js';
import { AssistantError, AssistantService, PAGES } from './assistant.service.js';

export const ASSISTANT = Symbol('ASSISTANT');

type Req = { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string }; user?: AuthedUser };

const askSchema = z
  .object({
    // The length cap is applied by the service (configurable); this bound only stops absurd bodies early.
    message: z.string().min(1).max(4000),
    lang: z.enum(['uz', 'ru', 'en']),
    page: z.enum(PAGES),
    conversationId: z.string().max(64).nullish(),
  })
  .strict();

function fail(res: Response, e: AssistantError): never {
  if (e.retryAfter) res.setHeader('Retry-After', String(e.retryAfter));
  throw new HttpException({ statusCode: e.status, code: e.code, message: e.message }, e.status);
}

/**
 * Public help assistant. No account is needed. A bearer token is optional: when it verifies and belongs to a platform
 * owner, the staging CLI adapter may answer (owner-only testing, decision 5a). The token is only verified here, never
 * used to provision a user or to read any account data.
 */
@Controller('v1/public/assistant')
export class AssistantController {
  constructor(@Inject(ASSISTANT) private readonly svc: AssistantService, @Inject(VERIFIER) private readonly verify: (t: string) => Promise<Identity>) {}

  private async owner(req: Req): Promise<boolean> {
    const h = req.headers['authorization'];
    if (typeof h !== 'string' || !h.startsWith('Bearer ') || this.svc.settings.ownerSubs.size === 0) return false;
    try {
      const id = await this.verify(h.slice(7));
      return id.role === 'org_admin' && this.svc.isOwner(id.sub);
    } catch {
      return false;
    }
  }

  @Get('status')
  async status(@Req() req: Req, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.svc.status({ owner: await this.owner(req) });
  }

  @Post('ask')
  @HttpCode(200)
  async ask(@Req() req: Req, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const parsed = askSchema.safeParse(body);
    if (!parsed.success) fail(res, new AssistantError(400, 'invalid_input', 'the question is not valid'));
    try {
      return await this.svc.ask(parsed.data, { ip: clientIp(req, this.svc.settings.trustedProxyHops), owner: await this.owner(req) });
    } catch (e) {
      if (e instanceof AssistantError) fail(res, e);
      throw e;
    }
  }
}

/** Platform owner only (PLATFORM_OWNER_SUBS): organization administrators of other organizations never pass. */
@Injectable()
export class PlatformOwnerGuard implements CanActivate {
  constructor(@Inject(ASSISTANT) private readonly svc: AssistantService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const user = ctx.switchToHttp().getRequest<Req>().user;
    if (!user || user.role !== 'org_admin' || !this.svc.isOwner(user.sub)) throw new ForbiddenException('platform owner only');
    return true;
  }
}

const listSchema = z.object({ before: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });

@Controller('v1/platform/assistant')
@UseGuards(AuthGuard)
export class AssistantOwnerController {
  constructor(@Inject(ASSISTANT) private readonly svc: AssistantService) {}

  /** Whether the signed-in person is a platform owner (the admin console shows the conversations section only then). */
  @Get('owner')
  owner(@Req() req: Req, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const u = req.user!;
    return { owner: u.role === 'org_admin' && this.svc.isOwner(u.sub) };
  }

  @Get('usage')
  @UseGuards(PlatformOwnerGuard)
  usage(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.svc.usageToday();
  }

  @Get('conversations')
  @UseGuards(PlatformOwnerGuard)
  async list(@Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const p = listSchema.safeParse(q);
    if (!p.success) throw new HttpException({ statusCode: 400, code: 'invalid_input', message: 'bad query' }, 400);
    let before: string | null = null;
    let beforeId: string | null = null;
    if (p.data.before) {
      const [at, id] = p.data.before.split('|');
      if (!at || Number.isNaN(Date.parse(at))) throw new HttpException({ statusCode: 400, code: 'invalid_input', message: 'bad cursor' }, 400);
      before = at;
      beforeId = id && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
    }
    return this.svc.list(before, beforeId, p.data.limit);
  }

  @Get('conversations/:id')
  @UseGuards(PlatformOwnerGuard)
  async messages(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const items = await this.svc.messages(id);
    if (!items.length) throw new NotFoundException();
    return { items };
  }

  @Delete('conversations/:id')
  @HttpCode(204)
  @UseGuards(PlatformOwnerGuard)
  async remove(@Param('id') id: string) {
    if (!(await this.svc.remove(id))) throw new NotFoundException();
  }
}
