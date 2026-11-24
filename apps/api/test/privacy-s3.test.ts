import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createObjectEraser } from '../src/privacy/s3-eraser.js';

// Integration against the real object store of the dev stack (the same one the file-sharing suite uses), unique key prefix.
const cfg = loadConfig();
describe.skipIf(!cfg.S3_ENDPOINT || !cfg.S3_ACCESS_KEY)('S3ObjectEraser (real object storage)', () => {
  const s3 = new S3Client({ endpoint: cfg.S3_ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: cfg.S3_ACCESS_KEY!, secretAccessKey: cfg.S3_SECRET_KEY! } });
  const gone = async (bucket: string, key: string) => {
    try {
      await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return false;
    } catch (e) {
      return (e as { name?: string }).name === 'NoSuchKey';
    }
  };
  it('deletes a file object and a recording object, and a second delete is still success', async () => {
    for (const b of [cfg.S3_BUCKET, cfg.RECORDING_BUCKET]) {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: b }));
      } catch {
        await s3.send(new CreateBucketCommand({ Bucket: b }));
      }
    }
    const p = `privacy-test/${randomUUID()}`;
    await s3.send(new PutObjectCommand({ Bucket: cfg.S3_BUCKET, Key: `${p}/file`, Body: 'x' }));
    await s3.send(new PutObjectCommand({ Bucket: cfg.RECORDING_BUCKET, Key: `${p}/rec`, Body: 'x' }));
    const eraser = createObjectEraser(cfg)!;
    expect(eraser).not.toBeNull();
    await eraser.deleteFileObject(`${p}/file`);
    await eraser.deleteRecordingObject(`${p}/rec`);
    expect(await gone(cfg.S3_BUCKET, `${p}/file`)).toBe(true);
    expect(await gone(cfg.RECORDING_BUCKET, `${p}/rec`)).toBe(true);
    await expect(eraser.deleteFileObject(`${p}/file`)).resolves.toBeUndefined();
  });
});
