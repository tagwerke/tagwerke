// Object storage for uploaded documents (DOCUMENTS_PLAN.md D3).
//
// The bytes of a document live here, never in Postgres. That is the 2026-09-13 revision: chunked
// `bytea` kept `pg_dump` complete but cost a chunk table, content-addressed keys, a temp-id promote
// dance and refcount races — too much engineering for an upload layer.
//
// S3-compatible is the only backend. The same code reaches Cloudflare R2, a self-hosted Garage or
// MinIO, or real S3 — the difference is one env var. That is what keeps "self-hostable" true while
// we run R2 ourselves: point S3_ENDPOINT at your own box and nothing leaves your infrastructure.
//
// Unconfigured is a first-class state (D4): documents switch off cleanly, the way push does without
// VAPID keys, rather than half-working.

import { Readable } from 'node:stream';
import { S3Client, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export interface Blobstore {
  /** Streams `body` to `key`. Length need not be known ahead of time — this uploads in parts. */
  put(key: string, body: Readable, mime: string): Promise<void>;
  get(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  /** Cheap reachability probe, for the verify script and a future health surface. */
  ping(): Promise<void>;
}

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

export function s3Blobstore(cfg: S3Config): Blobstore {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // R2, Garage and MinIO all accept path style; virtual-host style needs per-bucket DNS that a
    // self-hoster will not have set up. Default on, overridable for a provider that requires it.
    forcePathStyle: cfg.forcePathStyle,
  });

  return {
    async put(key, body, mime) {
      // lib-storage, not PutObjectCommand: a PUT needs Content-Length up front, and we deliberately
      // do not know it — the whole point is never holding the file in memory to measure it. Upload
      // buffers one part at a time and aborts the multipart cleanly if the source stream errors,
      // which is how the size-cap abort in routes/documents.ts avoids leaving a partial object.
      const upload = new Upload({
        client,
        params: { Bucket: cfg.bucket, Key: key, Body: body, ContentType: mime },
      });
      await upload.done();
    },

    async get(key) {
      const out = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
      if (!out.Body) throw new Error(`empty body for ${key}`);
      return out.Body as Readable;
    },

    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },

    async ping() {
      await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    },
  };
}

/** Env keys that must ALL be present for documents to be enabled. */
const REQUIRED = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;

export function configFromEnv(): S3Config | null {
  if (REQUIRED.some((k) => !process.env[k])) return null;
  return {
    endpoint: process.env.S3_ENDPOINT!,
    bucket: process.env.S3_BUCKET!,
    // R2 wants the literal 'auto'; a real-S3 or MinIO deployment sets its own.
    region: process.env.S3_REGION ?? 'auto',
    accessKeyId: process.env.S3_ACCESS_KEY_ID!,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
  };
}

let cached: Blobstore | null | undefined;

/**
 * The process-wide store, or null when object storage is not configured. Built once and memoised —
 * an S3Client holds a connection pool, so one per process, not one per request.
 */
export function blobstore(): Blobstore | null {
  if (cached === undefined) {
    const cfg = configFromEnv();
    cached = cfg ? s3Blobstore(cfg) : null;
  }
  return cached;
}

/** Which env keys are missing, for a startup log that names the gap instead of failing silently. */
export function missingConfig(): string[] {
  return REQUIRED.filter((k) => !process.env[k]);
}
