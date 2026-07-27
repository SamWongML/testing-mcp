import {
  bigserial,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Drizzle schema — the typed query surface over the Postgres system-of-record + queue
 * plus the stage-1 `tasks` table that collapses DynamoDB's hot task
 * state into Postgres while the corpus is small ("dozens" row).
 *
 * The authoritative DDL lives in `migrations/*.sql` (hand-authored, applied by
 * `migrate()`); this file mirrors it for typed inserts/selects and is kept in sync by
 * hand. Ids are `text`, not `uuid`: the IR types every id as `z.string()` (the engine
 * defaults to `randomUUID()` but callers may pass any string), so `text` honors the
 * contract and avoids surprising uuid-cast failures on non-uuid run ids.
 */

/** Registry snapshot per manifest hash — reproducibility + reporting joins. */
export const manifests = pgTable("manifests", {
  hash: text("hash").primaryKey(),
  gitSha: text("git_sha"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const catalogEntries = pgTable(
  "catalog_entries",
  {
    manifestHash: text("manifest_hash").notNull(),
    id: text("id").notNull(),
    kind: text("kind").notNull(),
    version: integer("version").notNull(),
    tags: text("tags").array(),
    owner: text("owner"),
    isLongRunning: boolean("is_long_running"),
  },
  (t) => [primaryKey({ columns: [t.manifestHash, t.id] })],
);

/** Durable job queue claimed with `FOR UPDATE SKIP LOCKED`. */
export const jobs = pgTable("jobs", {
  id: text("id").primaryKey(),
  runId: text("run_id"),
  spec: jsonb("spec"),
  priority: integer("priority").notNull().default(0),
  status: text("status").notNull(),
  workerId: text("worker_id"),
  runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Crash count: incremented by the reaper each time this job's lease expires. */
  attempts: integer("attempts").notNull().default(0),
  /** Ceiling before the job is dead-lettered instead of requeued. */
  maxAttempts: integer("max_attempts").notNull().default(5),
  lastError: text("last_error"),
  /** First claim, preserved across reaps — a resumed run's true start. */
  firstClaimedAt: timestamp("first_claimed_at", { withTimezone: true }),
});

/**
 * Per-node execution checkpoints — operational state, not history. Written as each node
 * settles (before any dependent starts) so a re-claimed run resumes from the frontier rather
 * than re-firing requests that already went out; pruned on every terminal write, with a TTL
 * sweep as the backstop. `payload` is a redacted `StepResult`.
 */
export const runCheckpoints = pgTable(
  "run_checkpoints",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.nodeId] })],
);

/** Run history — the record. */
export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  entryId: text("entry_id"),
  // Reproducibility (invariant): every run records the manifest hash + git sha it
  // ran against. gitSha is denormalized onto the run (not only `manifests`) so a run row
  // is self-describing without waiting on the catalog-snapshot writer.
  manifestHash: text("manifest_hash"),
  gitSha: text("git_sha"),
  status: text("status"),
  params: jsonb("params"),
  env: text("env"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  durationMs: integer("duration_ms"),
  artifactUri: text("artifact_s3"),
  invokedBy: text("invoked_by"),
  /** 1 unless the run was resumed after a worker loss; mirrors `ExecutionResult.runAttempt`. */
  attempt: integer("attempt").notNull().default(1),
  firstStartedAt: timestamp("first_started_at", { withTimezone: true }),
});

export const stepResults = pgTable(
  "step_results",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    status: text("status"),
    timingMs: integer("timing_ms"),
    attempts: integer("attempts"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.nodeId] })],
);

export const assertionResults = pgTable(
  "assertion_results",
  {
    runId: text("run_id").notNull(),
    nodeId: text("node_id").notNull(),
    idx: integer("idx").notNull(),
    ok: boolean("ok"),
    message: text("message"),
  },
  (t) => [primaryKey({ columns: [t.runId, t.nodeId, t.idx] })],
);

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  at: timestamp("at", { withTimezone: true }).defaultNow(),
  principal: text("principal"),
  action: text("action"),
  entryId: text("entry_id"),
  params: jsonb("params"),
  scopes: text("scopes").array(),
});

/**
 * Stage-1 task state: the fields DynamoDB would hold, kept in Postgres
 * so "dozens" scale needs no second datastore. `expiresAt` is the TTL analog — a
 * cleanup deletes rows past it, mirroring DynamoDB's TTL result expiry.
 */
export const tasks = pgTable("tasks", {
  runId: text("run_id").primaryKey(),
  state: text("state").notNull(),
  progressPct: integer("progress_pct"),
  currentNode: text("current_node"),
  resultRef: text("result_ref"),
  error: text("error"),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
