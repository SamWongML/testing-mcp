import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";

import { IDEM_KEY_ATTR, TTL_ATTR, toEpochSeconds } from "./attributes";

/**
 * The `idempotency` table: `idem_key → run_id`, with a TTL so keys expire.
 * It decouples a caller's dedupe key from the run id, which the stage-1 Postgres path could
 * not do — `submitRun` there dedupes by making the idempotency key *be* the `runId`, so a
 * key like `"nightly-smoke"` would become the run id itself. Claiming here lets the server
 * mint a real run id and still collapse resubmissions onto the first one.
 *
 * Atomicity is a single conditional `PutItem`: exactly one concurrent caller can create the
 * key, and every loser reads back the winner's run id.
 */

export interface DynamoIdempotencyStoreOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
  /** How long a claimed key is honoured. Default 24h. */
  ttlMs?: number;
}

export interface IdempotencyClaim {
  /** The run id the key resolves to — the caller's, or the earlier winner's. */
  runId: string;
  /** True when this call created the mapping (i.e. the caller should actually enqueue). */
  claimed: boolean;
}

/** The seam the async submit path uses; kept separate from `TaskStateStore` because a
 * Postgres deployment dedupes with the task row's insert-only `create` instead. */
export interface IdempotencyStore {
  claim(key: string, runId: string, ttlMs?: number): Promise<IdempotencyClaim>;
  get(key: string): Promise<string | null>;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const RUN_ID_ATTR = "run_id";

export class DynamoIdempotencyStore implements IdempotencyStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly defaultTtlMs: number;

  constructor(options: DynamoIdempotencyStoreOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
    this.defaultTtlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  async claim(key: string, runId: string, ttlMs?: number): Promise<IdempotencyClaim> {
    const expiresAt = new Date(Date.now() + (ttlMs ?? this.defaultTtlMs));
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            [IDEM_KEY_ATTR]: key,
            [RUN_ID_ATTR]: runId,
            [TTL_ATTR]: toEpochSeconds(expiresAt),
          },
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": IDEM_KEY_ATTR },
        }),
      );
      return { runId, claimed: true };
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      const existing = await this.get(key);
      // A key that vanished between the failed condition and this read (TTL expiry) is
      // treated as unclaimed by this caller — the run id it maps to is gone either way.
      return { runId: existing ?? runId, claimed: false };
    }
  }

  async get(key: string): Promise<string | null> {
    const { Item } = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { [IDEM_KEY_ATTR]: key },
        ConsistentRead: true,
      }),
    );
    return (Item?.[RUN_ID_ATTR] as string | undefined) ?? null;
  }
}
