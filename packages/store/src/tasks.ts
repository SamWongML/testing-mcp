import { and, eq, isNotNull, lt, sql } from "drizzle-orm";

import type { Db } from "./db/client";
import { tasks } from "./db/schema";

/**
 * Hot task state (SEP-1686 §11.1). The `TaskStateStore` interface is the seam the MCP
 * layer (P8) polls and cancels through; `PostgresTaskStore` is the stage-1 backing that
 * collapses DynamoDB into Postgres (§18). The P11 DynamoDB adapter will implement this
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
  /** When the task was first created — SEP-1686 `Task.createdAt` (§11.1). */
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

export interface TaskStateStore {
  /** Create or fully replace a task row. */
  put(input: PutTaskInput): Promise<TaskRecord>;
  /** Insert-only create: returns the new row, or `null` if a task with that `runId`
   *  already exists (leaving it untouched). The atomic primitive idempotent run
   *  submission builds on — dedupe by the caller's idempotency key = runId. */
  create(input: PutTaskInput): Promise<TaskRecord | null>;
  get(runId: string): Promise<TaskRecord | null>;
  /** Patch the provided fields; returns the new row, or null if the task is absent. */
  update(runId: string, patch: TaskPatch): Promise<TaskRecord | null>;
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

function resolveExpiry(input: Pick<PutTaskInput, "expiresAt" | "ttlMs">): Date | null {
  if (input.expiresAt) return input.expiresAt;
  if (input.ttlMs !== undefined) return new Date(Date.now() + input.ttlMs);
  return null;
}

/** The column values a task row is written with (shared by `put` and `create`). `updatedAt`
 *  is appended only by the upsert path; on insert the column default fills it. */
function rowValues(input: PutTaskInput) {
  return {
    runId: input.runId,
    state: input.state,
    progressPct: input.progressPct ?? null,
    currentNode: input.currentNode ?? null,
    resultRef: input.resultRef ?? null,
    error: input.error ?? null,
    cancelRequested: input.cancelRequested ?? false,
    expiresAt: resolveExpiry(input),
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
