import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Pool } from 'pg';
import { KeycloakAdmin } from '../admin/identity-admin.js';
import { loadConfig } from '../config.js';
import { loadSignupSettings } from './limits.js';
import { SIGNUP, SignupController } from './signup.controller.js';
import { SignupService } from './signup.service.js';

const SIGNUP_POOL = Symbol('SIGNUP_POOL');

/**
 * Self-contained: it owns a small connection pool and reads its own settings, so AppModule only has to import it.
 * Without the Keycloak admin client (KEYCLOAK_ADMIN_URL / KEYCLOAK_ADMIN_CLIENT_SECRET) the endpoints answer 503
 * `signup_unavailable` and touch nothing, like the file endpoints without S3.
 */
@Module({
  controllers: [SignupController],
  providers: [
    { provide: SIGNUP_POOL, useFactory: () => new Pool({ connectionString: loadConfig().DATABASE_URL, max: 4 }) },
    {
      provide: SIGNUP,
      useFactory: (pool: Pool) => {
        const cfg = loadConfig();
        const identity =
          cfg.KEYCLOAK_ADMIN_URL && cfg.KEYCLOAK_ADMIN_CLIENT_SECRET
            ? new KeycloakAdmin({
                baseUrl: cfg.KEYCLOAK_ADMIN_URL,
                realm: cfg.KEYCLOAK_ADMIN_REALM,
                clientId: cfg.KEYCLOAK_ADMIN_REALM_CLIENT_ID,
                clientSecret: cfg.KEYCLOAK_ADMIN_CLIENT_SECRET,
              })
            : null;
        return new SignupService(pool, loadSignupSettings(process.env, cfg.LIVEKIT_API_SECRET), identity);
      },
      inject: [SIGNUP_POOL],
    },
  ],
})
export class SignupModule implements OnApplicationShutdown {
  constructor(@Inject(SIGNUP_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
