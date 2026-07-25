import type { Config } from "@atp/schema";
import type { S3Client } from "@aws-sdk/client-s3";
import { S3Client as S3 } from "@aws-sdk/client-s3";

import type { ArtifactStore } from "../artifacts";
import { LocalArtifactStore } from "../artifacts";
import type { Db } from "../db/client";
import { PostgresTaskStore, type TaskStateStore } from "../tasks";
import { createDocumentClient } from "./client";
import { DynamoIdempotencyStore, type IdempotencyStore } from "./dynamo-idempotency";
import { DynamoTaskStore } from "./dynamo-tasks";
import { S3ArtifactStore } from "./s3-artifacts";

/**
 * Config-driven store selection (P11; research §18's scalability curve). The whole point is
 * that **only this file** knows which backing is in play: callers ask the provider for a
 * task store and get the configured one, so moving from the stage-1 Postgres collapse to
 * DynamoDB is an environment change, not a code change.
 *
 * `forDb` takes the caller's Db/transaction handle because the Postgres store must join the
 * caller's transaction (that is what makes create-task + enqueue atomic). DynamoDB is an
 * external service and ignores it — see {@link TaskStoreProvider.transactional}, which the
 * submit path reads to decide whether it still needs a separate idempotency claim.
 */

export interface TaskStoreProvider {
  /** The task store to use, bound to `db` when the backing is transactional. */
  forDb: (db: Db) => TaskStateStore;
  /** True when the store shares the caller's Postgres transaction, so an insert-only
   *  `create()` is itself a sufficient dedupe for a submission. */
  transactional: boolean;
  /** Present only when a dedicated idempotency table is configured (§16.2). */
  idempotency?: IdempotencyStore;
  /** Release any SDK clients this provider owns. */
  close: () => void;
}

export function createTaskStoreProvider(config: Config): TaskStoreProvider {
  if (config.TASK_STORE === "postgres") {
    return {
      forDb: (db) => new PostgresTaskStore(db),
      transactional: true,
      close: () => {},
    };
  }

  if (!config.DYNAMO_TASKS_TABLE) {
    throw new Error("TASK_STORE=dynamodb requires DYNAMO_TASKS_TABLE");
  }
  const client = createDocumentClient({ endpoint: config.DYNAMO_ENDPOINT });
  const tasks = new DynamoTaskStore({ client, tableName: config.DYNAMO_TASKS_TABLE });
  const idempotency = config.DYNAMO_IDEMPOTENCY_TABLE
    ? new DynamoIdempotencyStore({ client, tableName: config.DYNAMO_IDEMPOTENCY_TABLE })
    : undefined;

  return {
    // DynamoDB is external to Postgres: the transaction handle is deliberately ignored.
    forDb: () => tasks,
    transactional: false,
    idempotency,
    close: () => client.destroy(),
  };
}

/**
 * The artifact-store equivalent (§16.3): filesystem in dev/test, S3 in a deployment.
 *
 * Unlike {@link createTaskStoreProvider} this returns the store directly, with no `close`.
 * There is nowhere meaningful to call one from — `ServerContext` holds the store for the
 * process's whole life and both entrypoints `process.exit()` immediately after shutdown, so
 * the S3 client's sockets go with the process. A `close` nobody calls is worse than none.
 */
export function createArtifactStore(config: Config, fallbackDir: string): ArtifactStore {
  if (config.ARTIFACT_STORE === "local") {
    return new LocalArtifactStore(config.ARTIFACT_DIR ?? fallbackDir);
  }
  if (!config.S3_BUCKET) {
    throw new Error("ARTIFACT_STORE=s3 requires S3_BUCKET");
  }
  const client: S3Client = new S3({
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: true } : {}),
  });
  return new S3ArtifactStore({ client, bucket: config.S3_BUCKET });
}
