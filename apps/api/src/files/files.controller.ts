import { Controller, Get, HttpException, Inject, Param, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { Response } from 'express';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { MeetingError } from '../meetings/meetings.service.js';
import { FilesService } from './files.service.js';
import { MAX_FILE_BYTES } from './policy.js';

export const FILES = Symbol('FILES');

type Req = IncomingMessage & { user: AuthedUser };

/** Reads the raw request body, refusing as soon as it exceeds the cap (no unbounded buffering). */
function readCapped(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return reject(new MeetingError(413, 'file too large'));
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > max) {
        reject(new MeetingError(413, 'file too large'));
        req.destroy();
        return;
      }
      parts.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof MeetingError) throw new HttpException(e.extra ? { statusCode: e.status, message: e.message, ...e.extra } : e.message, e.status);
    throw e;
  });
}

@Controller('v1/meetings')
@UseGuards(AuthGuard)
export class FilesController {
  constructor(@Inject(FILES) private readonly svc: FilesService) {}

  /** Raw body upload: PUT /v1/meetings/:code/files?name=report.pdf with the file bytes as the body. */
  @Put(':code/files')
  upload(@Req() req: Req, @Param('code') code: string, @Query('name') name: string) {
    if (!this.svc.enabled) throw new HttpException('file sharing is not configured', 503);
    if (typeof name !== 'string' || name.length === 0 || name.length > 400) throw new HttpException('invalid file name', 400);
    return wrap(readCapped(req, MAX_FILE_BYTES + 1).then((data) => this.svc.upload(req.user, code, name, data)));
  }

  @Get(':code/files/:id')
  async download(@Req() req: Req, @Param('code') code: string, @Param('id') id: string, @Res() res: Response) {
    const file = await wrap(this.svc.download(req.user, code, id));
    const ascii = file.name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(file.data);
  }
}
