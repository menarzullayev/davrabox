import { Controller, Get } from '@nestjs/common';

/** Liveness/readiness for orchestrators. Deliberately unauthenticated and free of internal details. */
@Controller()
export class HealthController {
  @Get('healthz')
  health() {
    return { status: 'ok' };
  }
}
