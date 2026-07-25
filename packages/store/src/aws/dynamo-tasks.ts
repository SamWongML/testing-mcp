import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DeleteCommand, GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

import type { PutTaskInput, TaskPatch, TaskRecord, TaskState, TaskStateStore } from "../tasks";
import { TASK_ATTRS, TASK_KEY_ATTR, fromEpochSeconds, toEpochSeconds } from "./attributes";

/**
 * Hot task state on DynamoDB (research §16.2, ADR-005) — the §18 "hundreds" stage, where
 * `tasks/get` polling moves off Postgres onto a single-digit-ms keyed lookup with native
 * TTL expiry. It implements the same {@link TaskStateStore} seam as `PostgresTaskStore`,
 * so nothing above the store changes when config selects it.
 *
 * Writes go through `UpdateItem`, not `PutItem`, even for the full-replace `put`: that is
 * what lets `created_at` survive a replace (`if_not_exists`) and what makes every write a
 * single conditional round-trip. Every attribute name is aliased because `state`, `error`
 * and `ttl` are DynamoDB reserved words.
 */

export interface DynamoTaskStoreOptions {
  client: DynamoDBDocumentClient;
  tableName: string;
}

type Item = Record<string, unknown>;

function toRecord(item: Item): TaskRecord {
  const ttl = item[TASK_ATTRS.expiresAt];
  return {
    runId: item[TASK_KEY_ATTR] as string,
    state: item[TASK_ATTRS.state] as TaskState,
    progressPct: (item[TASK_ATTRS.progressPct] as number | null | undefined) ?? null,
    currentNode: (item[TASK_ATTRS.currentNode] as string | null | undefined) ?? null,
    resultRef: (item[TASK_ATTRS.resultRef] as string | null | undefined) ?? null,
    error: (item[TASK_ATTRS.error] as string | null | undefined) ?? null,
    cancelRequested: Boolean(item[TASK_ATTRS.cancelRequested]),
    expiresAt: typeof ttl === "number" ? fromEpochSeconds(ttl) : null,
    createdAt: new Date(item[TASK_ATTRS.createdAt] as string),
    updatedAt: new Date(item[TASK_ATTRS.updatedAt] as string),
  };
}

function resolveExpiry(input: Pick<PutTaskInput, "expiresAt" | "ttlMs">): Date | undefined {
  if (input.expiresAt) return input.expiresAt;
  if (input.ttlMs !== undefined) return new Date(Date.now() + input.ttlMs);
  return undefined;
}

interface UpdateParts {
  UpdateExpression: string;
  ExpressionAttributeNames: Record<string, string>;
  ExpressionAttributeValues?: Record<string, unknown>;
}

/**
 * Build a SET/REMOVE update over aliased attribute names. An attribute mapped to
 * `undefined` is REMOVEd (absent ⇒ `null` when read back), which is how the full-replace
 * `put` clears fields the caller omitted. `rawSets` carries fragments that reference a
 * function rather than a bare value (`if_not_exists`).
 */
function buildUpdate(values: Item, rawSets: Record<string, string> = {}): UpdateParts {
  const names: Record<string, string> = {};
  const attrValues: Item = {};
  const sets: string[] = [];
  const removes: string[] = [];

  for (const [attr, value] of Object.entries(values)) {
    const alias = `#${attr}`;
    names[alias] = attr;
    if (value === undefined) {
      removes.push(alias);
    } else {
      attrValues[`:${attr}`] = value;
      sets.push(`${alias} = :${attr}`);
    }
  }
  for (const [attr, fragment] of Object.entries(rawSets)) {
    names[`#${attr}`] = attr;
    sets.push(fragment);
  }

  const clauses = [
    sets.length ? `SET ${sets.join(", ")}` : "",
    removes.length ? `REMOVE ${removes.join(", ")}` : "",
  ].filter(Boolean);

  return {
    UpdateExpression: clauses.join(" "),
    ExpressionAttributeNames: names,
    ...(Object.keys(attrValues).length ? { ExpressionAttributeValues: attrValues } : {}),
  };
}

export class DynamoTaskStore implements TaskStateStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoTaskStoreOptions) {
    this.client = options.client;
    this.tableName = options.tableName;
  }

  private key(runId: string): Item {
    return { [TASK_KEY_ATTR]: runId };
  }

  /** Every mutable attribute a full write sets; omitted inputs become REMOVEs. */
  private replaceValues(input: PutTaskInput): Item {
    const expiresAt = resolveExpiry(input);
    return {
      [TASK_ATTRS.state]: input.state,
      [TASK_ATTRS.progressPct]: input.progressPct,
      [TASK_ATTRS.currentNode]: input.currentNode,
      [TASK_ATTRS.resultRef]: input.resultRef,
      [TASK_ATTRS.error]: input.error,
      [TASK_ATTRS.cancelRequested]: input.cancelRequested ?? false,
      [TASK_ATTRS.expiresAt]: expiresAt ? toEpochSeconds(expiresAt) : undefined,
    };
  }

  /** Apply an update and return the resulting record; `null` when `condition` rejected it. */
  private async write(
    runId: string,
    values: Item,
    opts: { condition?: string; preserveCreatedAt?: boolean } = {},
  ): Promise<TaskRecord | null> {
    const now = new Date().toISOString();
    const parts = buildUpdate(
      { ...values, [TASK_ATTRS.updatedAt]: now },
      opts.preserveCreatedAt
        ? { [TASK_ATTRS.createdAt]: `#${TASK_ATTRS.createdAt} = if_not_exists(#${TASK_ATTRS.createdAt}, :created)` }
        : {},
    );
    if (opts.preserveCreatedAt) {
      parts.ExpressionAttributeValues = { ...parts.ExpressionAttributeValues, ":created": now };
    }
    // The condition references the partition key, which is never in the update itself.
    if (opts.condition) parts.ExpressionAttributeNames[`#${TASK_KEY_ATTR}`] = TASK_KEY_ATTR;
    try {
      const { Attributes } = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: this.key(runId),
          ...parts,
          ...(opts.condition ? { ConditionExpression: opts.condition } : {}),
          ReturnValues: "ALL_NEW",
        }),
      );
      return Attributes ? toRecord(Attributes) : null;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return null;
      throw err;
    }
  }

  async put(input: PutTaskInput): Promise<TaskRecord> {
    // No condition: create-or-replace. `created_at` survives via `if_not_exists`.
    const record = await this.write(input.runId, this.replaceValues(input), {
      preserveCreatedAt: true,
    });
    return record!;
  }

  async create(input: PutTaskInput): Promise<TaskRecord | null> {
    const item: Item = {
      ...this.key(input.runId),
      ...this.replaceValues(input),
      [TASK_ATTRS.createdAt]: new Date().toISOString(),
      [TASK_ATTRS.updatedAt]: new Date().toISOString(),
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          // Insert-only: the `ON CONFLICT DO NOTHING` equivalent (§16.2). An existing run
          // is left untouched and the caller sees `null`.
          ConditionExpression: "attribute_not_exists(#pk)",
          ExpressionAttributeNames: { "#pk": TASK_KEY_ATTR },
        }),
      );
      return toRecord(item);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return null;
      throw err;
    }
  }

  async get(runId: string): Promise<TaskRecord | null> {
    const { Item } = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: this.key(runId),
        // Task state drives cancellation and terminal reads; a stale replica read could
        // resurrect a cancelled run, so every read is strongly consistent.
        ConsistentRead: true,
      }),
    );
    return Item ? toRecord(Item) : null;
  }

  async update(runId: string, patch: TaskPatch): Promise<TaskRecord | null> {
    const values: Item = {};
    for (const [field, attr] of Object.entries(TASK_ATTRS)) {
      const value = patch[field as keyof TaskPatch];
      if (value === undefined) continue; // patch semantics: absent ⇒ untouched
      values[attr] = value instanceof Date ? toEpochSeconds(value) : value;
    }
    if (Object.keys(values).length === 0) return this.get(runId);
    // Absent task ⇒ null, matching the Postgres store's "no row updated" result.
    return this.write(runId, values, { condition: `attribute_exists(#${TASK_KEY_ATTR})` });
  }

  async setProgress(runId: string, progressPct: number, currentNode?: string): Promise<void> {
    await this.update(runId, { progressPct, currentNode });
  }

  async requestCancel(runId: string): Promise<boolean> {
    return (await this.update(runId, { cancelRequested: true })) !== null;
  }

  /**
   * Deterministic TTL sweep. In production DynamoDB's **native** TTL is the primary reaper —
   * it deletes expired items for free, but only "within a few days" of expiry, and never on
   * dynamodb-local. This scan-and-delete makes expiry immediate and observable (and keeps
   * the `TaskStateStore` contract identical across backends); it is safe to run alongside
   * native TTL because deleting an already-deleted key is a no-op.
   */
  async deleteExpired(now: Date = new Date()): Promise<number> {
    const cutoff = toEpochSeconds(now);
    let startKey: Item | undefined;
    let deleted = 0;

    do {
      const page = await this.client.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression: "attribute_exists(#ttl) AND #ttl < :cutoff",
          // Both names are aliased: `ttl` is a reserved word, and aliasing the key keeps
          // the projection valid whatever the key attribute is named.
          ExpressionAttributeNames: { "#ttl": TASK_ATTRS.expiresAt, "#pk": TASK_KEY_ATTR },
          ExpressionAttributeValues: { ":cutoff": cutoff },
          ProjectionExpression: "#pk",
          ExclusiveStartKey: startKey,
        }),
      );
      for (const item of page.Items ?? []) {
        await this.client.send(
          new DeleteCommand({ TableName: this.tableName, Key: this.key(item[TASK_KEY_ATTR] as string) }),
        );
        deleted += 1;
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);

    return deleted;
  }
}
