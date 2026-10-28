import { createReadStream, existsSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import type { Readable } from 'node:stream';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import { config } from './config.js';

/**
 * Object storage. "local" writes to a directory on disk (default, zero dependencies).
 * "s3" targets any S3-compatible server you host yourself (MinIO, SeaweedFS, Garage, Ceph).
 */
export interface Storage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ stream: Readable; size?: number } | null>;
  remove(key: string): Promise<void>;
  ping(): Promise<boolean>;
  readonly kind: string;
}

class LocalStorage implements Storage {
  kind = 'local';
  constructor(private root: string) {}
  private path(key: string) {
    const p = normalize(join(this.root, key));
    if (!p.startsWith(normalize(this.root))) throw new Error('Invalid storage key');
    return p;
  }
  async put(key: string, body: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string) {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    const s = await stat(p);
    return { stream: createReadStream(p), size: s.size };
  }
  async remove(key: string) {
    await rm(this.path(key), { force: true });
  }
  async ping() {
    await mkdir(this.root, { recursive: true });
    return true;
  }
}

class S3Storage implements Storage {
  kind = 's3';
  private client: S3Client;
  private bucketChecked = false;
  constructor() {
    this.client = new S3Client({
      endpoint: config.storage.s3Endpoint || undefined,
      region: config.storage.s3Region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.storage.s3AccessKey, secretAccessKey: config.storage.s3SecretKey },
    });
  }
  private async ensureBucket() {
    if (this.bucketChecked) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: config.storage.s3Bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: config.storage.s3Bucket }));
    }
    this.bucketChecked = true;
  }
  async put(key: string, body: Buffer, contentType: string) {
    await this.ensureBucket();
    await this.client.send(new PutObjectCommand({ Bucket: config.storage.s3Bucket, Key: key, Body: body, ContentType: contentType }));
  }
  async get(key: string) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: config.storage.s3Bucket, Key: key }));
      return { stream: res.Body as Readable, size: res.ContentLength };
    } catch {
      return null;
    }
  }
  async remove(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: config.storage.s3Bucket, Key: key }));
  }
  async ping() {
    try {
      await this.ensureBucket();
      return true;
    } catch {
      return false;
    }
  }
}

export const storage: Storage = config.storage.driver === 's3' ? new S3Storage() : new LocalStorage(config.storage.localDir);
