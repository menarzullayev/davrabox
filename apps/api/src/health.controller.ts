import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { SkipRateLimit } from './rate-limit/guard.js';
import { READINESS, type ReadinessService } from './readiness.js';

/**
 * Probes for orchestrators. Deliberately unauthenticated, exempt from the global rate limits and free of internal details.
 *  - GET /healthz  liveness: the process answers. Never touches a dependency, so a database outage cannot make an
 *                  orchestrator restart healthy API processes.
 *  - GET /readyz   readiness: Postgres, the media server's API and (when configured) Redis; 503 + one boolean per dependency
 *                  when the instance cannot do its job. Redis alone down is "degraded" (HTTP 200): limits fall back to memory.
 */
@Controller()
@SkipRateLimit()
export class HealthController {
  constructor(@Inject(READINESS) private readonly readiness: ReadinessService) {}

  @Get('healthz')
  health() {
    return { status: 'ok' };
  }

  @Get('readyz')
  async ready(@Res({ passthrough: true }) res: Response) {
    const r = await this.readiness.check();
    res.setHeader('Cache-Control', 'no-store');
    if (r.status === 'unavailable') res.status(503);
    return r;
  }
}
