import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { AuthGuard, POOL, VERIFIER } from '../auth/auth.guard.js';
import { createVerifier } from '../auth/jwt.js';
import { AdminGuard } from '../admin/admin.controller.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { ApiKeysService } from './api-keys.service.js';
import { loadExtConfig, type ExtConfig } from './ext-config.js';
import { KeysController } from './keys.controller.js';
import { EXT_CONFIG, EXT_KEYS } from './tokens.js';

/**
 * External REST API (API keys) and webhooks. Self-contained so that the shared AppModule only has to import it:
 * it builds its own small database pool and token verifier from the same environment.
 */
@Module({
  controllers: [KeysController],
  providers: [
    { provide: EXT_CONFIG, useFactory: () => loadExtConfig() },
    { provide: POOL, useFactory: () => new Pool({ connectionString: loadConfig().DATABASE_URL, max: 6 }) },
    {
      provide: VERIFIER,
      useFactory: () => {
        const cfg: Config = loadConfig();
        return createVerifier(cfg.KEYCLOAK_ISSUER, cfg.KEYCLOAK_AUDIENCE, cfg.KEYCLOAK_JWKS_URL);
      },
    },
    { provide: EXT_KEYS, useFactory: (pool: Pool, ext: ExtConfig) => new ApiKeysService(pool, ext), inject: [POOL, EXT_CONFIG] },
    AuthGuard,
    AdminGuard,
    ApiKeyGuard,
  ],
})
export class ExtApiModule {}
