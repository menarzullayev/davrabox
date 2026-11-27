import { Body, Controller, Get, Header, HttpException, Inject, Put, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { AdminGuard } from '../admin/admin.controller.js';
import { SettingsError, type SettingsService } from './settings.service.js';

export const SETTINGS_SVC = Symbol('SETTINGS_SVC');

type Req = { user: AuthedUser };

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof SettingsError) throw new HttpException({ statusCode: e.status, code: e.code, message: e.message }, e.status);
    throw e;
  });
}
const body = (b: unknown): Record<string, unknown> => {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) throw new HttpException({ statusCode: 400, code: 'invalid_input', message: 'invalid input' }, 400);
  return b as Record<string, unknown>;
};

/** "My settings": the person's own values (null resets one to the organization's default). */
@Controller('v1/me/settings')
@UseGuards(AuthGuard)
export class MySettingsController {
  constructor(@Inject(SETTINGS_SVC) private readonly svc: SettingsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Req() req: Req) {
    return wrap(this.svc.view(req.user));
  }

  @Put()
  @Header('Cache-Control', 'no-store')
  put(@Req() req: Req, @Body() b: unknown) {
    return wrap(this.svc.setMine(req.user, body(b)));
  }
}

/** Organization defaults and locks ({key: {value, locked}} or null to drop the organization's choice). Admins only. */
@Controller('v1/admin/settings')
@UseGuards(AuthGuard, AdminGuard)
export class OrgSettingsController {
  constructor(@Inject(SETTINGS_SVC) private readonly svc: SettingsService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  get(@Req() req: Req) {
    return wrap(this.svc.orgView(req.user));
  }

  @Put()
  async put(@Req() req: Req, @Body() b: unknown) {
    await wrap(this.svc.setOrg(req.user, body(b)));
    return wrap(this.svc.orgView(req.user));
  }
}
