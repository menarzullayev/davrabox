import { Body, Controller, Get, HttpCode, HttpException, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { noControl } from '../common/text.js';
import { MeetingError, MeetingsService } from './meetings.service.js';

export const MEETINGS = Symbol('MEETINGS');

const createSchema = z.object({
  title: z.string().trim().min(1).max(200).refine(noControl),
  passcode: z.string().min(6).max(64).refine(noControl).optional(),
  scheduledAt: z.string().datetime().optional(),
  waitingRoom: z.boolean().optional(),
  e2ee: z.boolean().optional(),
  guests: z.enum(['off', 'waiting_room', 'open']).optional(),
}).strict(); // strict: a client that ever sent an E2EE meeting key here fails loudly instead of the server silently dropping it
const joinSchema = z.object({ passcode: z.string().max(64).refine(noControl).optional() });
const lockSchema = z.object({ locked: z.boolean() });

type Req = { user: AuthedUser; headers: Record<string, string | string[] | undefined> };

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof MeetingError) throw new HttpException(e.message, e.status);
    throw e;
  });
}

function hostOf(req: Req): string | undefined {
  const fwd = req.headers['x-forwarded-host'];
  return (Array.isArray(fwd) ? fwd[0] : fwd) ?? (req.headers['host'] as string | undefined);
}

@Controller('v1/meetings')
@UseGuards(AuthGuard)
export class MeetingsController {
  constructor(@Inject(MEETINGS) private readonly svc: MeetingsService) {}

  @Get()
  list(@Req() req: Req) {
    return this.svc.list(req.user);
  }

  @Get('settings')
  settings(@Req() req: Req) {
    return this.svc.settings(req.user);
  }

  @Post()
  create(@Req() req: Req, @Body() body: unknown) {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new HttpException('invalid input', 400);
    return wrap(this.svc.create(req.user, parsed.data));
  }

  /** Only the guest setting (`guests`) can change after creation, within the organization's limit; `e2ee` is an explicit 409. */
  @Patch(':code')
  update(@Req() req: Req, @Param('code') code: string, @Body() body: unknown) {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpException('invalid input', 400);
    return wrap(this.svc.update(req.user, code, body as Record<string, unknown>));
  }

  @Post(':code/join')
  @HttpCode(200)
  join(@Req() req: Req, @Param('code') code: string, @Body() body: unknown) {
    const parsed = joinSchema.safeParse(body ?? {});
    if (!parsed.success) throw new HttpException('invalid input', 400);
    return wrap(this.svc.join(req.user, code, parsed.data.passcode, hostOf(req)));
  }

  /** Waiting participants poll this; an admission answers with the join token. */
  @Get(':code/requests/:id')
  requestStatus(@Req() req: Req, @Param('code') code: string, @Param('id') id: string) {
    return wrap(this.svc.requestStatus(req.user, code, id, hostOf(req)));
  }

  @Get(':code/requests')
  listRequests(@Req() req: Req, @Param('code') code: string) {
    return wrap(this.svc.listRequests(req.user, code));
  }

  @Post(':code/requests/:id/admit')
  @HttpCode(200)
  admit(@Req() req: Req, @Param('code') code: string, @Param('id') id: string) {
    return wrap(this.svc.decide(req.user, code, id, true));
  }

  @Post(':code/requests/:id/deny')
  @HttpCode(200)
  deny(@Req() req: Req, @Param('code') code: string, @Param('id') id: string) {
    return wrap(this.svc.decide(req.user, code, id, false));
  }

  @Post(':code/lock')
  @HttpCode(200)
  lock(@Req() req: Req, @Param('code') code: string, @Body() body: unknown) {
    const parsed = lockSchema.safeParse(body);
    if (!parsed.success) throw new HttpException('invalid input', 400);
    return wrap(this.svc.setLocked(req.user, code, parsed.data.locked));
  }

  @Post(':code/participants/:identity/mute')
  @HttpCode(200)
  mute(@Req() req: Req, @Param('code') code: string, @Param('identity') identity: string) {
    return wrap(this.svc.muteParticipant(req.user, code, identity));
  }

  @Post(':code/participants/:identity/remove')
  @HttpCode(200)
  remove(@Req() req: Req, @Param('code') code: string, @Param('identity') identity: string) {
    return wrap(this.svc.removeParticipant(req.user, code, identity));
  }

  @Get(':code/me')
  me(@Req() req: Req, @Param('code') code: string) {
    return wrap(this.svc.myRole(req.user, code));
  }

  @Get(':code/cohosts')
  cohosts(@Req() req: Req, @Param('code') code: string) {
    return wrap(this.svc.listCohosts(req.user, code));
  }

  @Post(':code/cohosts/:identity/grant')
  @HttpCode(200)
  grantCohost(@Req() req: Req, @Param('code') code: string, @Param('identity') identity: string) {
    return wrap(this.svc.setCohost(req.user, code, identity, true));
  }

  @Post(':code/cohosts/:identity/revoke')
  @HttpCode(200)
  revokeCohost(@Req() req: Req, @Param('code') code: string, @Param('identity') identity: string) {
    return wrap(this.svc.setCohost(req.user, code, identity, false));
  }
}
