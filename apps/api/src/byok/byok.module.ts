import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../auth/auth.guard.js';
import { loadConfig } from '../config.js';
import { masterKeyFrom } from '../files/crypto.js';
import { BYOK, ByokController } from './byok.controller.js';
import { ByokService } from './byok.service.js';

/** Without FILE_MASTER_KEY there is nothing to encrypt the Vault token with, so every endpoint answers 503. */
export function createByokService(pool: Pool, cfg = loadConfig()): ByokService {
  return new ByokService(pool, cfg.FILE_MASTER_KEY ? masterKeyFrom(cfg.FILE_MASTER_KEY) : null, { allowPrivate: cfg.BYOK_ALLOW_PRIVATE_VAULT });
}

/** Added to AppModule with one spread each (see app.module.ts). Needs the shared POOL provider. */
export const byokControllers = [ByokController];
export const byokProviders: Provider[] = [{ provide: BYOK, useFactory: (pool: Pool) => createByokService(pool), inject: [POOL] }];
