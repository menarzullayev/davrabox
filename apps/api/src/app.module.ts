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

export const CONFIG = Symbol('CONFIG');

@Module({
  controllers: [MeetingsController, FilesController, HealthController],
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    { provide: POOL, useFactory: (cfg: Config) => new Pool({ connectionString: cfg.DATABASE_URL, max: 10 }), inject: [CONFIG] },
    { provide: VERIFIER, useFactory: (cfg: Config) => createVerifier(cfg.KEYCLOAK_ISSUER, cfg.KEYCLOAK_AUDIENCE, cfg.KEYCLOAK_JWKS_URL), inject: [CONFIG] },
    { provide: MEETINGS, useFactory: (pool: Pool, cfg: Config) => new MeetingsService(pool, cfg), inject: [POOL, CONFIG] },
    { provide: FILES, useFactory: (pool: Pool, cfg: Config) => new FilesService(pool, cfg), inject: [POOL, CONFIG] },
    AuthGuard,
  ],
})
export class AppModule {}
