import { Body, Controller, Get, Header, HttpCode, HttpException, Inject, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { noControl } from '../common/text.js';
import type { ActivityTracker } from './activity.js';
import { MEETINGS } from './meetings.controller.js';
import { MeetingError, type MeetingsService } from './meetings.service.js';
import type { PersonalRoomService } from './personal-room.js';

export const PERSONAL_ROOM = Symbol('PERSONAL_ROOM');
export const ACTIVITY = Symbol('ACTIVITY');

const passcode = z.string().min(6).max(64).refine(noControl);
export const ensureSchema = z.object({ title: z.string().trim().min(1).max(200).refine(noControl), passcode: passcode.optional() }).strict();
export const patchSchema = z
  .object({ passcode: passcode.nullable(), waitingRoom: z.boolean(), guests: z.enum(['off', 'waiting_room', 'open']) })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0);
const limitSchema = z.coerce.number().int().min(1).max(50).default(10);

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

/** The signed-in person's own things on the home screen: personal room, recent activity, the device check. */
@Controller('v1/me')
@UseGuards(AuthGuard)
export class MeController {
  constructor(
    @Inject(PERSONAL_ROOM) private readonly rooms: PersonalRoomService,
    @Inject(ACTIVITY) private readonly activity: ActivityTracker,
    @Inject(MEETINGS) private readonly meetings: MeetingsService,
  ) {}

  @Get('personal-room')
  @Header('Cache-Control', 'no-store')
  personalRoom(@Req() req: Req) {
    return wrap(this.rooms.get(req.user));
  }

  /** Creates the personal room on first use (idempotent). */
  @Post('personal-room')
  @HttpCode(200)
  ensure(@Req() req: Req, @Body() body: unknown) {
    const parsed = ensureSchema.safeParse(body);
    if (!parsed.success) throw new HttpException('invalid input', 400);
    return wrap(this.rooms.ensure(req.user, parsed.data));
  }

  @Patch('personal-room')
  update(@Req() req: Req, @Body() body: unknown) {
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) throw new HttpException('invalid input', 400);
    return wrap(this.rooms.update(req.user, parsed.data));
  }

  /** A new number and link; the old one stops working. */
  @Post('personal-room/regenerate')
  @HttpCode(200)
  regenerate(@Req() req: Req) {
    return wrap(this.rooms.regenerate(req.user));
  }

  /** Ended meetings the person hosted or was in: duration, head count, files and recordings when there are any. */
  @Get('activity')
  @Header('Cache-Control', 'no-store')
  async recent(@Req() req: Req, @Query('limit') limit?: string) {
    const n = limitSchema.safeParse(limit ?? undefined);
    if (!n.success) throw new HttpException('invalid input', 400);
    return { items: await this.activity.recent(req.user.orgId, req.user.userId, n.data) };
  }

  /** A short-lived token for a throw-away room: the device check page tests the real media server with it. */
  @Post('connection-test')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  connectionTest(@Req() req: Req) {
    return wrap(this.meetings.connectionTest(req.user, hostOf(req)));
  }
}
