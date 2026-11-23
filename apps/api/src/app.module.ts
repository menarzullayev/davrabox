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

import { ADMIN, AdminController, AdminGuard } from './admin/admin.controller.js';
import { AdminService } from './admin/admin.service.js';
import { KeycloakAdmin } from './admin/identity-admin.js';

export const CONFIG = Symbol('CONFIG');

@Module({
  controllers: [MeetingsController, FilesController, AdminController, HealthController],
  providers: [
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
    AuthGuard,
    AdminGuard,
  ],
})
export class AppModule {}
