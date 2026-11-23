import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { loadConfig, type Config } from './config.js';
import { AuthGuard, POOL, VERIFIER } from './auth/auth.guard.js';
import { createVerifier } from './auth/jwt.js';
import { MEETINGS, MeetingsController } from './meetings/meetings.controller.js';
import { MeetingsService } from './meetings/meetings.service.js';
import { HealthController } from './health.controller.js';
import { FILES, FilesController } from './files/files.controller.js';
import { FilesService } from './files/files.service.js';
import { AUDIT, AuditAdminGuard, AuditController } from './audit/audit.controller.js';
import { AuditService } from './audit/audit.service.js';
import { AuditForwarder } from './audit/forwarder.js';

import { ADMIN, AdminController, AdminGuard } from './admin/admin.controller.js';
import { AdminService } from './admin/admin.service.js';
import { KeycloakAdmin } from './admin/identity-admin.js';
import { SignupModule } from './signup/signup.module.js';
import { ExtApiModule } from './ext-api/ext-api.module.js';
import { recordingControllers, recordingProviders } from './recording/recording.module.js';
import { calendarControllers, calendarProviders } from './calendar/calendar.module.js';
import { byokControllers, byokProviders } from './byok/byok.module.js';
import { privacyControllers, privacyProviders } from './privacy/privacy.module.js';

export const AUDIT_FORWARDER = Symbol('AUDIT_FORWARDER');
export const CONFIG = Symbol('CONFIG');

@Module({
  imports: [SignupModule, ExtApiModule],
  controllers: [MeetingsController, FilesController, AdminController, AuditController, HealthController, ...recordingControllers, ...calendarControllers, ...byokControllers, ...privacyControllers],
  providers: [
    ...recordingProviders,
    ...byokProviders,
    ...privacyProviders,
    { provide: CONFIG, useFactory: () => loadConfig() },
    { provide: POOL, useFactory: (cfg: Config) => new Pool({ connectionString: cfg.DATABASE_URL, max: 10 }), inject: [CONFIG] },
    { provide: VERIFIER, useFactory: (cfg: Config) => createVerifier(cfg.KEYCLOAK_ISSUER, cfg.KEYCLOAK_AUDIENCE, cfg.KEYCLOAK_JWKS_URL), inject: [CONFIG] },
    { provide: MEETINGS, useFactory: (pool: Pool, cfg: Config) => new MeetingsService(pool, cfg), inject: [POOL, CONFIG] },
    { provide: FILES, useFactory: (pool: Pool, cfg: Config) => new FilesService(pool, cfg), inject: [POOL, CONFIG] },
    {
      provide: ADMIN,
      useFactory: (pool: Pool, cfg: Config) =>
        new AdminService(
          pool,
          cfg.KEYCLOAK_ADMIN_URL && cfg.KEYCLOAK_ADMIN_CLIENT_SECRET
            ? new KeycloakAdmin({
                baseUrl: cfg.KEYCLOAK_ADMIN_URL,
                realm: cfg.KEYCLOAK_ADMIN_REALM,
                clientId: cfg.KEYCLOAK_ADMIN_REALM_CLIENT_ID,
                clientSecret: cfg.KEYCLOAK_ADMIN_CLIENT_SECRET,
              })
            : null,
        ),
      inject: [POOL, CONFIG],
    },
    { provide: AUDIT, useFactory: (pool: Pool, cfg: Config) => new AuditService(pool, cfg.LIVEKIT_API_SECRET), inject: [POOL, CONFIG] },
    {
      provide: AUDIT_FORWARDER,
      useFactory: (pool: Pool, cfg: Config) =>
        cfg.AUDIT_WEBHOOK_URL && cfg.AUDIT_WEBHOOK_SECRET
          ? new AuditForwarder(pool, { url: cfg.AUDIT_WEBHOOK_URL, secret: cfg.AUDIT_WEBHOOK_SECRET, intervalMs: cfg.AUDIT_FORWARD_INTERVAL_MS })
          : null,
      inject: [POOL, CONFIG],
    },
    ...calendarProviders,
    AuthGuard,
    AdminGuard,
    AuditAdminGuard,
  ],
})
export class AppModule {}
