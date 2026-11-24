import { Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { createPool } from '../db/pool.js';
import { RoomServiceClient } from 'livekit-server-sdk';
import { livekitClientOptions } from '../common/timeouts.js';
import { KeycloakAdmin } from '../admin/identity-admin.js';
import { AuthGuard, POOL, VERIFIER } from '../auth/auth.guard.js';
import { createVerifier } from '../auth/jwt.js';
import { loadConfig, type Config } from '../config.js';
import { loadSignupSettings } from './limits.js';
import { TrialRetentionJob } from './retention.job.js';
import { TrialRoomSweeper } from './room-sweeper.js';
import { SIGNUP, SignupController } from './signup.controller.js';
import { SignupService } from './signup.service.js';
import { TRIAL_LIMITS, TrialController } from './trial.controller.js';
import { TrialLimits } from './trial.guard.js';

export const SIGNUP_POOL = Symbol('SIGNUP_POOL');
const SIGNUP_CONFIG = Symbol('SIGNUP_CONFIG');
const KEYCLOAK = Symbol('SIGNUP_KEYCLOAK');
const RETENTION = Symbol('TRIAL_RETENTION');
const SWEEPER = Symbol('TRIAL_SWEEPER');

/**
 * Self-contained: it owns a small connection pool and reads its own settings, so AppModule only has to import it.
 * Without the Keycloak admin client (KEYCLOAK_ADMIN_URL / KEYCLOAK_ADMIN_CLIENT_SECRET) the sign-up endpoints answer 503
 * `signup_unavailable` and touch nothing, like the file endpoints without S3. The two background jobs (trial retention,
 * trial room watchdog) run unless SIGNUP_BACKGROUND_JOBS=0.
 */
@Module({
  controllers: [SignupController, TrialController],
  providers: [
    { provide: SIGNUP_CONFIG, useFactory: () => loadConfig() },
    { provide: SIGNUP_POOL, useFactory: (cfg: Config) => createPool(cfg.DATABASE_URL, 4), inject: [SIGNUP_CONFIG] },
    {
      provide: KEYCLOAK,
      useFactory: (cfg: Config) =>
        cfg.KEYCLOAK_ADMIN_URL && cfg.KEYCLOAK_ADMIN_CLIENT_SECRET
          ? new KeycloakAdmin({
              baseUrl: cfg.KEYCLOAK_ADMIN_URL,
              realm: cfg.KEYCLOAK_ADMIN_REALM,
              clientId: cfg.KEYCLOAK_ADMIN_REALM_CLIENT_ID,
              clientSecret: cfg.KEYCLOAK_ADMIN_CLIENT_SECRET,
            })
          : null,
      inject: [SIGNUP_CONFIG],
    },
    {
      provide: SIGNUP,
      useFactory: (pool: Pool, cfg: Config, kc: KeycloakAdmin | null) => new SignupService(pool, loadSignupSettings(process.env, cfg.LIVEKIT_API_SECRET), kc),
      inject: [SIGNUP_POOL, SIGNUP_CONFIG, KEYCLOAK],
    },
    { provide: TRIAL_LIMITS, useFactory: (pool: Pool) => new TrialLimits(pool), inject: [SIGNUP_POOL] },
    // The trial status endpoint is authenticated like every other one.
    { provide: POOL, useExisting: SIGNUP_POOL },
    { provide: VERIFIER, useFactory: (cfg: Config) => createVerifier(cfg.KEYCLOAK_ISSUER, cfg.KEYCLOAK_AUDIENCE, cfg.KEYCLOAK_JWKS_URL), inject: [SIGNUP_CONFIG] },
    AuthGuard,
    { provide: RETENTION, useFactory: (pool: Pool, kc: KeycloakAdmin | null) => new TrialRetentionJob(pool, kc), inject: [SIGNUP_POOL, KEYCLOAK] },
    {
      provide: SWEEPER,
      useFactory: (pool: Pool, cfg: Config) => new TrialRoomSweeper(pool, new RoomServiceClient(cfg.LIVEKIT_API_URL, cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, livekitClientOptions())),
      inject: [SIGNUP_POOL, SIGNUP_CONFIG],
    },
  ],
})
export class SignupModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(SIGNUP_POOL) private readonly pool: Pool,
    @Inject(RETENTION) private readonly retention: TrialRetentionJob,
    @Inject(SWEEPER) private readonly sweeper: TrialRoomSweeper,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env['SIGNUP_BACKGROUND_JOBS'] === '0') return;
    this.retention.start();
    this.sweeper.start();
  }

  async onApplicationShutdown(): Promise<void> {
    this.retention.stop();
    this.sweeper.stop();
    if (!this.pool.ended) await this.pool.end(); // ManagedPool also closes itself; either order is safe
  }
}
