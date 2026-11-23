import type { Readable } from 'node:stream';
import { CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ObjectStore } from './recording.service.js';

export class S3Store implements ObjectStore {
  private readonly s3: S3Client;
  private ready = false;

  constructor(o: { endpoint: string; accessKey: string; secretKey: string; region: string }, private readonly bucket: string) {
    this.s3 = new S3Client({ endpoint: o.endpoint, region: o.region, forcePathStyle: true, credentials: { accessKeyId: o.accessKey, secretAccessKey: o.secretKey } });
  }

  async ensure(): Promise<void> {
    if (this.ready) return;
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
    this.ready = true;
  }

  async get(key: string): Promise<Readable> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return r.Body as Readable;
  }

  async put(key: string, body: Readable, length: number): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentLength: length, ContentType: 'application/octet-stream' }));
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
