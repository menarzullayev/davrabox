import { Controller, Get, Header, Inject, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { TrialLimits } from './trial.guard.js';

export const TRIAL_LIMITS = Symbol('TRIAL_LIMITS');

/** What the application needs to show the "trial ends soon" banner: the caller's own organization only. */
@Controller('v1/trial')
@UseGuards(AuthGuard)
export class TrialController {
  constructor(@Inject(TRIAL_LIMITS) private readonly trial: TrialLimits) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  status(@Req() req: { user: AuthedUser }) {
    return this.trial.status(req.user.orgId);
  }
}
