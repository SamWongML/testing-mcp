import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { ArtifactStore, PutResult } from "../artifacts";

/**
 * S3-backed artifacts behind the same {@link ArtifactStore} seam
 * as `LocalArtifactStore`: blobs (trace.json, report.html/md, logs) live in the bucket,
 * only pointers live in Postgres. Keys come from `artifactKey()` — the shared
 * `{env}/{yyyy}/{mm}/{dd}/{runId}/{name}` layout the bucket's lifecycle rules partition on.
 *
 * Redact-before-persist still holds: the engine redacts an `ExecutionResult` before it ever
 * reaches a store, so this adapter, like the local one, writes what it is handed.
 */

export interface S3ArtifactStoreOptions {
  client: S3Client;
  bucket: string;
  /** Default lifetime for `presign`ed URLs, in seconds (default 15 minutes). */
  presignExpiresSec?: number;
}

const DEFAULT_PRESIGN_SEC = 15 * 60;

export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly presignExpiresSec: number;

  constructor(options: S3ArtifactStoreOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
    this.presignExpiresSec = options.presignExpiresSec ?? DEFAULT_PRESIGN_SEC;
  }

  async put(key: string, body: string | Uint8Array, contentType?: string): Promise<PutResult> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    return { key, uri: this.uri(key) };
  }

  async get(key: string): Promise<Buffer> {
    const { Body } = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!Body) throw new Error(`artifact has no body: ${key}`);
    return Buffer.from(await Body.transformToByteArray());
  }

  /** A time-limited HTTPS URL the holder can GET with no AWS credentials — how
   * `get_report` and the `run://` resources hand large artifacts to agents and humans. */
  async presign(key: string, expiresSec: number = this.presignExpiresSec): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn: expiresSec },
    );
  }

  uri(key: string): string {
    return `s3://${this.bucket}/${key}`;
  }
}
