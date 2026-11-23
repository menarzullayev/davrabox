import { Controller, Delete, Get, HttpException, Inject, Param, Post, Query, Req, Res, UseGuards, Body } from '@nestjs/common';
import type { Response } from 'express';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { MeetingError } from '../meetings/meetings.service.js';
import { isProvider } from './providers/types.js';
import { CalendarEventsService } from './events.service.js';
import { CalendarOAuthService } from './oauth.service.js';

export const CALENDAR_OAUTH = Symbol('CALENDAR_OAUTH');
export const CALENDAR_EVENTS = Symbol('CALENDAR_EVENTS');

type Req = { user: AuthedUser; headers: Record<string, string | string[] | undefined> };

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof MeetingError) throw new HttpException(e.message, e.status);
    throw e;
  });
}

const one = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

@Controller('v1/calendar')
export class CalendarController {
  constructor(@Inject(CALENDAR_OAUTH) private readonly oauth: CalendarOAuthService) {}

  /** Which providers are configured on this server and which the caller has connected. */
  @Get()
  @UseGuards(AuthGuard)
  list(@Req() req: Req) {
    return this.oauth.list(req.user);
  }

  /**
   * Starts the connection. Answers 302 to the provider's consent page. A browser navigation cannot carry the bearer
   * token, so the web app calls this with fetch and `Accept: application/json` and receives `{ url }` instead, then
   * navigates there itself.
   */
  @Get(':provider/start')
  @UseGuards(AuthGuard)
  async start(@Req() req: Req, @Param('provider') provider: string, @Res() res: Response) {
    const { url } = await wrap(this.oauth.start(req.user, provider));
    res.setHeader('Cache-Control', 'no-store');
    if (String(req.headers['accept'] ?? '').includes('application/json')) {
      res.status(200).json({ url });
      return;
    }
    res.redirect(302, url);
  }

  /**
   * The provider sends the browser back here (no bearer token: the server-side state identifies the user). An invalid
   * state is a plain 400; every other outcome redirects to the web app on our own configured origin.
   */
  @Get(':provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query('code') code: unknown,
    @Query('state') state: unknown,
    @Query('error') error: unknown,
    @Res() res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer'); // the url carries the authorization code
    const out = await wrap(this.oauth.callback(provider, { code: one(code), state: one(state), error: one(error) }));
    if (!isProvider(provider)) throw new HttpException('unknown calendar provider', 404);
    res.redirect(302, this.oauth.appRedirect(out.ok ? 'connected' : out.reason === 'denied' ? 'denied' : 'error', provider));
  }

  @Delete(':provider')
  @UseGuards(AuthGuard)
  disconnect(@Req() req: Req, @Param('provider') provider: string) {
    return wrap(this.oauth.disconnect(req.user, provider));
  }
}

@Controller('v1/meetings')
@UseGuards(AuthGuard)
export class CalendarEventsController {
  constructor(@Inject(CALENDAR_EVENTS) private readonly events: CalendarEventsService) {}

  @Post(':code/calendar-event')
  create(@Req() req: Req, @Param('code') code: string, @Body() body: unknown) {
    return wrap(this.events.createEvent(req.user, code, body));
  }
}
