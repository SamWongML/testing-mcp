/**
 * The DynamoDB item shape for the hot task state + idempotency tables (research §16.2).
 * Attribute names are snake_case to match the research spec and the CDK table definitions,
 * and several of them (`state`, `error`, `ttl`) are DynamoDB reserved words — every
 * expression that mentions one must alias it through `ExpressionAttributeNames`.
 */

/** `tasks` partition key. */
export const TASK_KEY_ATTR = "run_id";
/** `idempotency` partition key. */
export const IDEM_KEY_ATTR = "idem_key";

/** The TTL attribute DynamoDB's native expiry reads. Epoch **seconds**, not millis. */
export const TTL_ATTR = "ttl";

/** Attribute names for the mutable task fields, keyed by their `TaskRecord` field. */
export const TASK_ATTRS = {
  state: "state",
  progressPct: "progress_pct",
  currentNode: "current_node",
  resultRef: "result_ref",
  error: "error",
  cancelRequested: "cancel_requested",
  expiresAt: TTL_ATTR,
  createdAt: "created_at",
  updatedAt: "updated_at",
} as const satisfies Record<string, string>;

/** DynamoDB TTL is expressed in epoch seconds; the store's interface uses `Date`. */
export const toEpochSeconds = (d: Date): number => Math.floor(d.getTime() / 1000);
export const fromEpochSeconds = (n: number): Date => new Date(n * 1000);
