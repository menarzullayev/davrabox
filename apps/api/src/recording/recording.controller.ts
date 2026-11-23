import { Controller, Get, HttpCode, HttpException, Inject, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { pipeline } from 'node:stream';
import type { Response } from 'express';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { MeetingError } from '../meetings/meetings.service.js';
import { RecordingService } from './recording.service.js';

export const RECORDING = Symbol('RECORDING');

type Req = { user: AuthedUser };

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof MeetingError) throw new HttpException(e.message, e.status);
    throw e;
  });
}

/** Host, co-host or org admin only (enforced in the service, with an audit row for every refusal). */
@Controller('v1')
@UseGuards(AuthGuard)
export class RecordingController {
  constructor(@Inject(RECORDING) private readonly svc: RecordingService) {}

  /** Whether recording is available and running; any participant of the meeting may ask (it drives the consent badge). */
  @Get('meetings/:code/recording')
  status(@Req() req: Req, @Param('code') code: string) {
    return wrap(this.svc.status(req.user, code));
  }

  @Post('meetings/:code/recording/start')
  @HttpCode(200)
  start(@Req() req: Req, @Param('code') code: string) {
    return wrap(this.svc.start(req.user, code));
  }

  @Post('meetings/:code/recording/stop')
  @HttpCode(200)
  stop(@Req() req: Req, @Param('code') code: string) {
    return wrap(this.svc.stop(req.user, code));
  }

  @Get('meetings/:code/recordings')
  list(@Req() req: Req, @Param('code') code: string) {
    return wrap(this.svc.list(req.user, code));
  }

  @Get('recordings/:id/download')
  async download(@Req() req: Req, @Param('id') id: string, @Res() res: Response) {
    const file = await wrap(this.svc.download(req.user, id));
    const ascii = file.name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    // An integrity failure mid-stream aborts the response instead of delivering a silently damaged file.
    pipeline(file.stream, res, () => undefined);
  }
}
