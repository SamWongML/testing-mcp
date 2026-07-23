import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Artifact storage behind an interface (research §16.3, ADR-005): blobs (trace.json,
 * report.html/md, logs) live here, only pointers live in Postgres. `LocalArtifactStore`
 * backs dev/tests; the `S3ArtifactStore` is deferred to P11 (the AWS phase) behind this
 * same interface, alongside the DynamoDB task-store adapter — nothing above the store
 * changes when it slots in.
 */

export interface PutResult {
  key: string;
  /** A location reference for the stored object (persisted into `runs.artifact_s3`). */
  uri: string;
}

export interface ArtifactStore {
  put(key: string, body: string | Uint8Array, contentType?: string): Promise<PutResult>;
  get(key: string): Promise<Buffer>;
  /** A URL a client can fetch the object from (S3 presigned; local `file://`). */
  presign(key: string, expiresSec?: number): Promise<string>;
  /** The stable location reference for a key (no I/O). */
  uri(key: string): string;
}

/** Canonical key layout `{env}/{yyyy}/{mm}/{dd}/{runId}/{name}` (§16.3). */
export function artifactKey(params: {
  env: string;
  runId: string;
  name: string;
  now?: Date;
}): string {
  const d = params.now ?? new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${params.env}/${yyyy}/${mm}/${dd}/${params.runId}/${params.name}`;
}

/** Filesystem-backed artifact store for local dev and tests. */
export class LocalArtifactStore implements ArtifactStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = resolve(baseDir);
  }

  /** Resolve a key under the base dir, rejecting traversal outside it. */
  private pathFor(key: string): string {
    const full = resolve(this.baseDir, key);
    const rel = relative(this.baseDir, full);
    if (isAbsolute(key) || rel === ".." || rel.startsWith(`..${sep}`)) {
      throw new Error(`artifact key escapes base dir: ${key}`);
    }
    return full;
  }

  async put(key: string, body: string | Uint8Array): Promise<PutResult> {
    const full = this.pathFor(key);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
    return { key, uri: this.uri(key) };
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async presign(key: string): Promise<string> {
    // No signing locally — the file:// URL is directly fetchable in dev.
    return this.uri(key);
  }

  uri(key: string): string {
    return pathToFileURL(join(this.baseDir, key)).href;
  }
}
