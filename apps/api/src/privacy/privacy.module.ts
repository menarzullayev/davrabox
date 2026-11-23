import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { KeycloakAdmin } from '../admin/identity-admin.js';
import { POOL, type AuthedUser } from '../auth/auth.guard.js';
import { CALENDAR_OAUTH } from '../calendar/calendar.controller.js';
import type { CalendarOAuthService } from '../calendar/oauth.service.js';
import { loadConfig, type Config } from '../config.js';
import { AdminPrivacyController, MePrivacyController, PRIVACY } from './privacy.controller.js';
import type { CalendarRevoker, ObjectEraser } from './ports.js';
import { PrivacyService } from './privacy.service.js';
import { PrivacyRetentionJob, retentionSettings } from './retention.job.js';
import { createObjectEraser } from './s3-eraser.js';

const PRIVACY_CONFIG = Symbol('PRIVACY_CONFIG');
const PRIVACY_OBJECTS = Symbol('PRIVACY_OBJECTS');
const PRIVACY_RETENTION = Symbol('PRIVACY_RETENTION');

/** Revokes the stored calendar grants at Google and Microsoft through the calendar service (which also deletes the rows). */
export class CalendarOAuthRevoker implements CalendarRevoker {
  constructor(private readonly oauth: CalendarOAuthService) {}

  async revokeAll(orgId: string, userId: string): Promise<void> {
    const who = { orgId, userId, sub: '', email: '', name: '', orgSlug: '', role: 'member' } satisfies AuthedUser;
    for (const provider of ['google', 'microsoft']) {
      try {
        await this.oauth.disconnect(who, provider);
      } catch {
        /* provider not configured on this server, or unreachable: the stored copy is deleted by the erasure itself */
      }
    }
  }
}

/** Starts the hourly retention job after bootstrap (not when PRIVACY_BACKGROUND_JOBS or SIGNUP_BACKGROUND_JOBS is 0). */
@Injectable()
export class PrivacyLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(@Inject(PRIVACY_RETENTION) private readonly job: PrivacyRetentionJob) {}

  onApplicationBootstrap(): void {
    if (process.env['PRIVACY_BACKGROUND_JOBS'] === '0' || process.env['SIGNUP_BACKGROUND_JOBS'] === '0') return;
    this.job.start();
  }

  onApplicationShutdown(): void {
    this.job.stop();
  }
}

/** Added to AppModule with one spread each (see app.module.ts). Needs the shared POOL and the calendar providers. */
export const privacyControllers = [MePrivacyController, AdminPrivacyController];

export const privacyProviders: Provider[] = [
  { provide: PRIVACY_CONFIG, useFactory: () => loadConfig() },
  { provide: PRIVACY_OBJECTS, useFactory: (cfg: Config) => createObjectEraser(cfg), inject: [PRIVACY_CONFIG] },
  {
    provide: PRIVACY,
    useFactory: (pool: Pool, cfg: Config, objects: ObjectEraser | null, oauth: CalendarOAuthService) =>
      new PrivacyService(pool, {
        idp:
          cfg.KEYCLOAK_ADMIN_URL && cfg.KEYCLOAK_ADMIN_CLIENT_SECRET
            ? new KeycloakAdmin({ baseUrl: cfg.KEYCLOAK_ADMIN_URL, realm: cfg.KEYCLOAK_ADMIN_REALM, clientId: cfg.KEYCLOAK_ADMIN_REALM_CLIENT_ID, clientSecret: cfg.KEYCLOAK_ADMIN_CLIENT_SECRET })
            : null,
        objects,
        calendar: new CalendarOAuthRevoker(oauth),
      }),
    inject: [POOL, PRIVACY_CONFIG, PRIVACY_OBJECTS, CALENDAR_OAUTH],
  },
  {
    provide: PRIVACY_RETENTION,
    useFactory: (pool: Pool, cfg: Config, objects: ObjectEraser | null, svc: PrivacyService) => new PrivacyRetentionJob(pool, { objects, erasure: svc }, retentionSettings(cfg)),
    inject: [POOL, PRIVACY_CONFIG, PRIVACY_OBJECTS, PRIVACY],
  },
  PrivacyLifecycle,
];
