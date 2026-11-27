import { Body, Controller, Delete, Get, Header, HttpCode, HttpException, Inject, Injectable, Param, Post, Put, Req, Res, UseGuards, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import type { IncomingMessage } from 'node:http';
import type { Response } from 'express';
import { z } from 'zod';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { noControl } from '../common/text.js';
import { RateLimitService } from '../rate-limit/service.js';
import { AVATAR_MAX_BYTES } from './image.js';
import { ProfileError, type ProfileService } from './profile.service.js';
import type { SecurityService } from './security.service.js';

export const PROFILE = Symbol('PROFILE');
export const SECURITY = Symbol('SECURITY');

const text = (max: number) => z.string().trim().max(max).refine(noControl).nullable();
export const profilePatchSchema = z
  .object({
    jobTitle: text(100),
    departmentId: z.string().uuid().nullable(),
    phone: z.string().trim().regex(/^(\+?[0-9 ()-]{5,24})?$/).nullable(),
    timeZone: z.string().max(64).regex(/^[A-Za-z_+-]+(\/[A-Za-z0-9_+-]+){0,2}$/).nullable(),
    dateFormat: z.enum(['dmy', 'mdy', 'ymd']).nullable(),
    timeFormat: z.enum(['24h', '12h']).nullable(),
  })
  .partial()
  .strict();

type Req = IncomingMessage & { user: AuthedUser; headers: Record<string, string | string[] | undefined> };

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof ProfileError) throw new HttpException({ statusCode: e.status, code: e.code, message: e.message }, e.status);
    if ((e as { status?: number }).status === 502 || (e as { name?: string }).name === 'IdentityAdminError') throw new HttpException({ statusCode: 502, code: 'idp', message: 'identity provider error' }, 502);
    throw e;
  });
}

function readCapped(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > max) return reject(new ProfileError(413, 'too_large', 'the picture is larger than 2 MB'));
    const parts: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
      size += d.length;
      if (size > max) {
        reject(new ProfileError(413, 'too_large', 'the picture is larger than 2 MB'));
        req.destroy();
        return;
      }
      parts.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/** The signed-in person's profile and self-service security (owner decisions 1-3 of the profile package). */
@Controller('v1/me')
@UseGuards(AuthGuard)
export class ProfileController {
  constructor(
    @Inject(PROFILE) private readonly profile: ProfileService,
    @Inject(SECURITY) private readonly security: SecurityService,
  ) {}

  @Get('profile')
  @Header('Cache-Control', 'no-store')
  get(@Req() req: Req) {
    return wrap(this.profile.get(req.user));
  }

  @Put('profile')
  @Header('Cache-Control', 'no-store')
  update(@Req() req: Req, @Body() body: unknown) {
    const parsed = profilePatchSchema.safeParse(body);
    if (!parsed.success) throw new HttpException({ statusCode: 400, code: 'invalid_input', message: 'invalid input' }, 400);
    return wrap(this.profile.update(req.user, parsed.data));
  }

  /** Raw body: the square picture the browser cropped (JPEG, PNG or WebP, at most 2 MB). */
  @Put('avatar')
  avatar(@Req() req: Req) {
    return wrap(readCapped(req, AVATAR_MAX_BYTES).then((data) => this.profile.setAvatar(req.user, data)));
  }

  @Delete('avatar')
  @HttpCode(204)
  async removeAvatar(@Req() req: Req) {
    await wrap(this.profile.deleteAvatar(req.user));
  }

  @Get('security')
  @Header('Cache-Control', 'no-store')
  securityView(@Req() req: Req) {
    return wrap(this.security.view(req.user));
  }

  @Post('security/sessions/:sid/end')
  @HttpCode(204)
  async endSession(@Req() req: Req, @Param('sid') sid: string) {
    await wrap(this.security.endSession(req.user, sid));
  }

  @Post('security/sessions/end-all')
  @HttpCode(204)
  async endAll(@Req() req: Req) {
    await wrap(this.security.endAll(req.user));
  }

  @Delete('security/links/:provider')
  @HttpCode(204)
  async unlink(@Req() req: Req, @Param('provider') provider: string) {
    if (!/^[a-z0-9-]{1,40}$/.test(provider)) throw new HttpException('not found', 404);
    await wrap(this.security.unlink(req.user, provider));
  }
}

/** Another member of the organization as the caller may see them (owner decision 5). */
@Controller('v1/people')
@UseGuards(AuthGuard)
export class PeopleController {
  constructor(@Inject(PROFILE) private readonly profile: ProfileService) {}

  @Get(':id')
  @Header('Cache-Control', 'private, max-age=60')
  card(@Req() req: Req, @Param('id') id: string) {
    return wrap(this.profile.card(req.user, id));
  }
}

/**
 * Pictures by their random id. No sign-in: the id is handed only to people who share a meeting with the person (join
 * token) or their organization, and it changes on every upload. Served as an image only (no sniffing, sandboxed).
 */
@Controller('v1/avatars')
export class AvatarController {
  constructor(@Inject(PROFILE) private readonly profile: ProfileService) {}

  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response) {
    const pic = await this.profile.avatar(id).catch(() => null);
    if (!pic) {
      res.status(404).setHeader('Cache-Control', 'no-store').json({ statusCode: 404, message: 'not found' });
      return;
    }
    res.setHeader('Content-Type', pic.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable'); // a new picture gets a new id
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.end(pic.data);
  }
}

/** Notes which device a signed-in session uses (for "Where you're signed in"); runs after the guards, never blocks. */
@Injectable()
export class DeviceInterceptor implements NestInterceptor {
  constructor(
    @Inject(SECURITY) private readonly security: SecurityService,
    @Inject(RateLimitService) private readonly rate: RateLimitService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest<Req>();
    if (req?.user?.sid) {
      const h = (k: string) => {
        const v = req.headers[k];
        return Array.isArray(v) ? v[0] : v;
      };
      let city = h('cf-ipcity');
      try {
        city = city ? decodeURIComponent(city) : undefined;
      } catch {
        /* keep as sent */
      }
      void this.security.record(req.user, { userAgent: h('user-agent'), ip: this.rate.clientIp(req), country: h('cf-ipcountry')?.toUpperCase(), city });
    }
    return next.handle();
  }
}
