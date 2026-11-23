import type { Provider } from '@nestjs/common';
import type { Pool } from 'pg';
import { POOL } from '../auth/auth.guard.js';
import { loadConfig, type Config } from '../config.js';
import { masterKeyFrom } from '../files/crypto.js';
import { RECORDING, RecordingController } from './recording.controller.js';
import { LiveKitMedia } from './livekit-media.js';
import { RecordingService } from './recording.service.js';
import { S3Store } from './s3-store.js';

/** Builds the recording service from the configuration; without Egress/S3/master key every endpoint answers 503. */
export function createRecordingService(pool: Pool, cfg: Config): RecordingService {
  if (!cfg.RECORDING_ENABLED || !cfg.S3_ENDPOINT || !cfg.S3_ACCESS_KEY || !cfg.S3_SECRET_KEY || !cfg.FILE_MASTER_KEY) return new RecordingService(pool, null);
  const base = { accessKey: cfg.S3_ACCESS_KEY, secretKey: cfg.S3_SECRET_KEY, region: cfg.RECORDING_S3_REGION };
  return new RecordingService(pool, {
    master: masterKeyFrom(cfg.FILE_MASTER_KEY),
    store: new S3Store({ endpoint: cfg.S3_ENDPOINT, accessKey: base.accessKey, secretKey: base.secretKey, region: base.region }, cfg.RECORDING_BUCKET),
    media: new LiveKitMedia({
      apiUrl: cfg.LIVEKIT_API_URL,
      apiKey: cfg.LIVEKIT_API_KEY,
      apiSecret: cfg.LIVEKIT_API_SECRET,
      s3: { endpoint: cfg.RECORDING_S3_ENDPOINT ?? cfg.S3_ENDPOINT, bucket: cfg.RECORDING_BUCKET, ...base },
    }),
  });
}

/** Added to AppModule with one spread each (see app.module.ts). Needs the shared POOL provider. */
export const recordingControllers = [RecordingController];
export const recordingProviders: Provider[] = [{ provide: RECORDING, useFactory: (pool: Pool) => createRecordingService(pool, loadConfig()), inject: [POOL] }];
