import { Module } from '@nestjs/common';
import { Pool } from 'pg';
import { loadConfig, type Config } from '../config.js';
import { AuthGuard, POOL, VERIFIER } from '../auth/auth.guard.js';
import { createVerifier } from '../auth/jwt.js';
import { AdminGuard } from '../admin/admin.controller.js';
import { masterKeyFrom } from '../files/crypto.js';
import { MeetingsService } from '../meetings/meetings.service.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { ApiKeysService } from './api-keys.service.js';
import { loadExtConfig, type ExtConfig } from './ext-config.js';
import { ExtMeetingsService } from './ext-meetings.service.js';
import { ExtUsersService } from './ext-users.service.js';
import { createPoster } from './http-poster.js';
import { KeysController } from './keys.controller.js';
import { LivekitWebhookController } from './livekit-webhook.controller.js';
import { MeetingsExtController } from './meetings.ext.controller.js';
import { OpenApiController } from './openapi.js';
import { EXT_CONFIG, EXT_CORE_CONFIG, EXT_KEYS, EXT_MEETINGS, EXT_USERS, EXT_WEBHOOKS, WEBHOOK_JOB } from './tokens.js';
import { UsersExtController } from './users.ext.controller.js';
import { WebhookDeliveryJob } from './webhook-delivery.job.js';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';

/**
 * External REST API (API keys, /v1/ext) and signed webhooks. Self-contained so that the shared AppModule only has to
 * import it: it builds its own small database pool and token verifier from the same environment. Webhook signing
 * secrets are encrypted with the file master key (FILE_MASTER_KEY); without it the webhook endpoints answer 503 and the
 * delivery worker stays idle, like file sharing does.
 */
@Module({
  controllers: [KeysController, MeetingsExtController, UsersExtController, OpenApiController, WebhooksController, LivekitWebhookController],
  providers: [
    { provide: EXT_CONFIG, useFactory: () => loadExtConfig() },
    { provide: EXT_CORE_CONFIG, useFactory: () => loadConfig() },
    { provide: POOL, useFactory: (cfg: Config) => new Pool({ connectionString: cfg.DATABASE_URL, max: 6 }), inject: [EXT_CORE_CONFIG] },
    {
      provide: VERIFIER,
      useFactory: (cfg: Config) => createVerifier(cfg.KEYCLOAK_ISSUER, cfg.KEYCLOAK_AUDIENCE, cfg.KEYCLOAK_JWKS_URL),
      inject: [EXT_CORE_CONFIG],
    },
    { provide: EXT_KEYS, useFactory: (pool: Pool, ext: ExtConfig) => new ApiKeysService(pool, ext), inject: [POOL, EXT_CONFIG] },
    {
      provide: EXT_MEETINGS,
      useFactory: (pool: Pool, cfg: Config) => new ExtMeetingsService(pool, new MeetingsService(pool, cfg), cfg),
      inject: [POOL, EXT_CORE_CONFIG],
    },
    { provide: EXT_USERS, useFactory: (pool: Pool) => new ExtUsersService(pool), inject: [POOL] },
    {
      provide: EXT_WEBHOOKS,
      useFactory: (pool: Pool, cfg: Config) => new WebhooksService(pool, { master: cfg.FILE_MASTER_KEY ? masterKeyFrom(cfg.FILE_MASTER_KEY) : null }),
      inject: [POOL, EXT_CORE_CONFIG],
    },
    {
      provide: WEBHOOK_JOB,
      useFactory: (pool: Pool, cfg: Config, ext: ExtConfig) =>
        new WebhookDeliveryJob(pool, {
          master: cfg.FILE_MASTER_KEY ? masterKeyFrom(cfg.FILE_MASTER_KEY) : null,
          poster: createPoster(),
          timeoutMs: ext.WEBHOOK_REQUEST_TIMEOUT_MS,
          intervalMs: ext.WEBHOOK_DELIVERY_INTERVAL_MS,
        }),
      inject: [POOL, EXT_CORE_CONFIG, EXT_CONFIG],
    },
    AuthGuard,
    AdminGuard,
    ApiKeyGuard,
  ],
})
export class ExtApiModule {}
