import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from '../config.js';
import type { ObjectEraser } from './ports.js';

/** Deletes file-sharing and recording objects. S3 answers success for a missing key, so every call is repeatable. */
export class S3ObjectEraser implements ObjectEraser {
  private readonly files: S3Client;
  private readonly recordings: S3Client;

  constructor(private readonly cfg: Pick<Config, 'S3_BUCKET' | 'RECORDING_BUCKET'> & { endpoint: string; accessKey: string; secretKey: string; fileRegion?: string; recordingRegion: string }) {
    const credentials = { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey };
    this.files = new S3Client({ endpoint: cfg.endpoint, region: cfg.fileRegion ?? 'us-east-1', forcePathStyle: true, credentials });
    this.recordings = new S3Client({ endpoint: cfg.endpoint, region: cfg.recordingRegion, forcePathStyle: true, credentials });
  }

  async deleteFileObject(key: string): Promise<void> {
    await this.files.send(new DeleteObjectCommand({ Bucket: this.cfg.S3_BUCKET, Key: key }));
  }

  async deleteRecordingObject(key: string): Promise<void> {
    await this.recordings.send(new DeleteObjectCommand({ Bucket: this.cfg.RECORDING_BUCKET, Key: key }));
  }
}

/** Null when object storage is not configured (file sharing and recording are then off too, so no objects exist). */
export function createObjectEraser(cfg: Config): ObjectEraser | null {
  if (!cfg.S3_ENDPOINT || !cfg.S3_ACCESS_KEY || !cfg.S3_SECRET_KEY) return null;
  return new S3ObjectEraser({
    S3_BUCKET: cfg.S3_BUCKET,
    RECORDING_BUCKET: cfg.RECORDING_BUCKET,
    endpoint: cfg.S3_ENDPOINT,
    accessKey: cfg.S3_ACCESS_KEY,
    secretKey: cfg.S3_SECRET_KEY,
    recordingRegion: cfg.RECORDING_S3_REGION,
  });
}
