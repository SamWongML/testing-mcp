import { and, desc, eq, isNotNull, lt, sql } from "drizzle-orm";

import type { Db } from "./db/client";
import { decodeKeysetCursor, encodeKeysetCursor, isoSortKey } from "./keyset";
import { tasks } from "./db/schema";

/**
 * Hot task state (SEP-1686). The `TaskStateStore` interface is the seam the MCP
 * layer polls and cancels through; `PostgresTaskStore` is the stage-1 backing that
 * collapses DynamoDB into Postgres. The DynamoDB adapter will implement this
 * same interface, so nothing above the store changes when it swaps in.
 */

export type TaskState = "working" | "input_required" | "completed" | "failed" | "cancelled";

export interface TaskRecord {
  runId: string;
  state: TaskState;
  progressPct: number | null;
  currentNode: string | null;
  resultRef: string | null;
  error: string | null;
  cancelRequested: boolean;
  /** TTL: when the retained result expires and `deleteExpired` may reap it. */
  expiresAt: Date | null;
  /** When the task was first created — SEP-1686 `Task.createdAt`. */
  createdAt: Date;
  /** When the task row was last written — SEP-1686 `Task.lastUpdatedAt`. */
  updatedAt: Date;
}

export interface PutTaskInput {
  runId: string;
  state: TaskState;
  progressPct?: number;
  currentNode?: string;
  resultRef?: string;
  error?: string;
  cancelRequested?: boolean;
  /** Absolute expiry; or pass `ttlMs` to derive one from now. */
  expiresAt?: Date;
  ttlMs?: number;
}

export interface TaskPatch {
  state?: TaskState;
  progressPct?: number;
  currentNode?: string;
  resultRef?: string;
  error?: string;
  cancelRequested?: boolean;
  expiresAt?: Date;
}

export interface ListTasksOptions {
  /** Max rows per page; defaults to {@link DEFAULT_TASK_PAGE_SIZE}. */
  limit?: number;
  /** Opaque cursor from a previous page's `nextCursor`; omit for the first page. */
  cursor?: string;
}

export interface TaskPage {
  tasks: TaskRecord[];
  /** Absent means "end of results" — the protocol's own signal. */
  nextCursor?: string;
}

/** Rows per `list` page when the caller doesn't say. Bounded because the result is
 * marshaled straight into a calling agent's context window. */
export const DEFAULT_TASK_PAGE_SIZE = 100;
export const MAX_TASK_PAGE_SIZE = 500;

export interface TaskStateStore {
  /** Create or fully replace a task row. */
  put(input: PutTaskInput): Promise<TaskRecord>;
  /** Insert-only create: returns the new row, or `null` if a task with that `runId`
   * already exists (leaving it untouched). The atomic primitive idempotent run
   * submission builds on — dedupe by the caller's idempotency key = runId. */
  create(input: PutTaskInput): Promise<TaskRecord | null>;
  get(runId: string): Promise<TaskRecord | null>;
  /** Patch the provided fields; returns the new row, or null if the task is absent. */
  update(runId: string, patch: TaskPatch): Promise<TaskRecord | null>;
  /**
   * One page of tasks plus the cursor for the next. The contract both backends honour is
   * **complete traversal**: following `nextCursor` to exhaustion yields every stored task
   * exactly once. Ordering is backend-specific and deliberately not part of the contract —
   * Postgres pages newest-first over a `(created_at, run_id)` keyset; DynamoDB's `Scan`
   * order is arbitrary. Callers that need an order must sort.
   */
  list(opts?: ListTasksOptions): Promise<TaskPage>;
  /** Worker progress heartbeat (k/n nodes). */
  setProgress(runId: string, progressPct: number, currentNode?: string): Promise<void>;
  /** Set the cancel flag the worker polls; returns whether a row was flagged. */
  requestCancel(runId: string): Promise<boolean>;
  /** TTL sweep — delete rows past their expiry. Returns how many were removed. */
  deleteExpired(now?: Date): Promise<number>;
}

type Row = typeof tasks.$inferSelect;

function toRecord(row: Row): TaskRecord {
  return {
    runId: row.runId,
    state: row.state as TaskState,
    progressPct: row.progressPct,
    currentNode: row.currentNode,
    resultRef: row.resultRef,
    error: row.error,
    cancelRequested: row.cancelRequested,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Absolute expiry from either an explicit date or a relative TTL. Shared with the DynamoDB
 * adapter so the two backends can never disagree about what `ttlMs` means. */
export function resolveExpiry(input: Pick<PutTaskInput, "expiresAt" | "ttlMs">): Date | undefined {
  if (input.expiresAt) return input.expiresAt;
  if (input.ttlMs !== undefined) return new Date(Date.now() + input.ttlMs);
  return undefined;
}

/** The column values a task row is written with (shared by `put` and `create`). `updatedAt`
 * is appended only by the upsert path; on insert the column default fills it. */
function rowValues(input: PutTaskInput) {
  return {
    runId: input.runId,
    state: input.state,
    progressPct: input.progressPct ?? null,
    currentNode: input.currentNode ?? null,
    resultRef: input.resultRef ?? null,
    error: input.error ?? null,
    cancelRequested: input.cancelRequested ?? false,
    expiresAt: resolveExpiry(input) ?? null,
  };
}

export class PostgresTaskStore implements TaskStateStore {
  constructor(private readonly db: Db) {}

  async put(input: PutTaskInput): Promise<TaskRecord> {
    const values = { ...rowValues(input), updatedAt: sql`now()` };
    const [row] = await this.db
      .insert(tasks)
      .values(values)
      .onConflictDoUpdate({ target: tasks.runId, set: values })
      .returning();
    return toRecord(row!);
  }

  async create(input: PutTaskInput): Promise<TaskRecord | null> {
    const [row] = await this.db
      .insert(tasks)
      .values(rowValues(input))
      // Insert-only: a runId that already exists is left untouched and yields no row.
      .onConflictDoNothing({ target: tasks.runId })
      .returning();
    return row ? toRecord(row) : null;
  }

  async get(runId: string): Promise<TaskRecord | null> {
    const [row] = await this.db.select().from(tasks).where(eq(tasks.runId, runId));
    return row ? toRecord(row) : null;
  }

  async update(runId: string, patch: TaskPatch): Promise<TaskRecord | null> {
    const [row] = await this.db
      .update(tasks)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(tasks.runId, runId))
      .returning();
    return row ? toRecord(row) : null;
  }

  async list(opts: ListTasksOptions = {}): Promise<TaskPage> {
    const limit = Math.min(opts.limit ?? DEFAULT_TASK_PAGE_SIZE, MAX_TASK_PAGE_SIZE);
    const after = decodeKeysetCursor(opts.cursor);
    // `created_at` is NOT NULL, so the ordering is already total without a fallback.
    const sortKey = isoSortKey(tasks.createdAt);
    // Row-wise comparison is the keyset predicate for the composite `(sortKey DESC,
    // run_id DESC)` ordering — one condition, and total because `run_id` is unique.
    const where = after
      ? sql`(${sortKey}, ${tasks.runId}) < (${after.sortKey}, ${after.tiebreaker})`
      : undefined;
    // Over-fetch by one: the extra row is how we know more remain without a second query.
    const rows = await this.db
      .select({ task: tasks, sortKey })
      .from(tasks)
      .where(where)
      .orderBy(desc(sortKey), desc(tasks.runId))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const more = rows.length > limit && last !== undefined;
    return {
      tasks: page.map((r) => toRecord(r.task)),
      ...(more ? { nextCursor: encodeKeysetCursor(last.sortKey, last.task.runId) } : {}),
    };
  }

  async setProgress(runId: string, progressPct: number, currentNode?: string): Promise<void> {
    await this.update(runId, { progressPct, currentNode });
  }

  async requestCancel(runId: string): Promise<boolean> {
    const rows = await this.db
      .update(tasks)
      .set({ cancelRequested: true, updatedAt: sql`now()` })
      .where(eq(tasks.runId, runId))
      .returning({ runId: tasks.runId });
    return rows.length > 0;
  }

  async deleteExpired(now: Date = new Date()): Promise<number> {
    const rows = await this.db
      .delete(tasks)
      .where(and(isNotNull(tasks.expiresAt), lt(tasks.expiresAt, now)))
      .returning({ runId: tasks.runId });
    return rows.length;
  }
}
