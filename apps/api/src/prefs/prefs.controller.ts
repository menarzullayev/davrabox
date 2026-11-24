import { Body, Controller, Get, HttpException, Inject, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { DENSITY_IDS, LANG_IDS, STYLE_IDS, THEME_IDS } from './ids.js';
import { PrefsError, PrefsService, type PrefsPatch } from './prefs.service.js';

export const PREFS = Symbol('PREFS');

export const patchSchema = z
  .object({
    lang: z.enum(LANG_IDS).nullable(),
    theme: z.enum(THEME_IDS).nullable(),
    style: z.enum(STYLE_IDS).nullable(),
    density: z.enum(DENSITY_IDS).nullable(),
  })
  .partial()
  .strict();

type Req = { user: AuthedUser };

/** The signed-in person's own display preferences. */
@Controller('v1/me/prefs')
@UseGuards(AuthGuard)
export class PrefsController {
  constructor(@Inject(PREFS) private readonly svc: PrefsService) {}

  @Get()
  get(@Req() req: Req) {
    return this.svc.get(req.user);
  }

  @Put()
  async put(@Req() req: Req, @Body() body: unknown) {
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) throw new HttpException('invalid input', 400);
    try {
      return await this.svc.set(req.user, parsed.data as PrefsPatch);
    } catch (e) {
      if (e instanceof PrefsError) throw new HttpException(e.message, e.status);
      throw e;
    }
  }
}
