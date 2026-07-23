import { randomUUID } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Db } from "./db/client";
import { jobs } from "./db/schema";

/**
 * Durable job queue on Postgres — the no-broker dispatch pattern (research §11.2,
 * ADR-004). A worker claims exactly one job with `FOR UPDATE SKIP LOCKED` so many
 * workers contend safely; a heartbeat keeps the lease fresh and a reaper requeues
 * jobs whose worker died. Cancellation is a `cancel_requested` flag the worker polls
 * between nodes.
 */

export type Job = typeof jobs.$inferSelect;
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface EnqueueInput {
  /** The run this job will execute (the row the worker records history under). */
  runId?: string;
  /** Opaque run spec (entry id + params + env) the worker needs to execute. */
  spec?: unknown;
  /** Higher runs first; ties broken by age. */
  priority?: number;
  /** Delay availability until this time (retry/backoff); defaults to now. */
  runAfter?: Date;
}

export async function enqueue(db: Db, input: EnqueueInput = {}): Promise<Job> {
  const [row] = await db
    .insert(jobs)
    .values({
      id: randomUUID(),
      runId: input.runId ?? null,
      spec: input.spec ?? null,
      priority: input.priority ?? 0,
      status: "queued",
      runAfter: input.runAfter, // undefined → DB default now()
    })
    .returning();
  return row!;
}

/**
 * Claim the highest-priority ready job, or `null` if none. The `SELECT … FOR UPDATE
 * SKIP LOCKED` inside the transaction row-locks the pick so concurrent claimers skip
 * it and take the next one — no job is ever claimed twice. The follow-up UPDATE returns
 * the fully typed row.
 */
export async function claim(db: Db, workerId: string): Promise<Job | null> {
  return db.transaction(async (tx) => {
    const picked = await tx.execute<{ id: string }>(sql`
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_after <= now()
      ORDER BY priority DESC, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    const id = picked.rows[0]?.id;
    if (!id) return null;
    const [row] = await tx
      .update(jobs)
      .set({ status: "running", workerId, claimedAt: sql`now()` })
      .where(eq(jobs.id, id))
      .returning();
    return row ?? null;
  });
}

/** Refresh a running job's lease. Returns false if this worker no longer owns it. */
export async function heartbeat(db: Db, jobId: string, workerId: string): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ claimedAt: sql`now()` })
    .where(and(eq(jobs.id, jobId), eq(jobs.workerId, workerId), eq(jobs.status, "running")))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/**
 * Move a claimed job to a terminal state so the reaper leaves it alone. Guarded by
 * worker ownership + `running` status (like `heartbeat`): a worker that lost its lease
 * to the reaper cannot finalize a job another worker has since claimed. Returns false
 * when this worker no longer owns a running job by that id.
 */
export async function markDone(
  db: Db,
  jobId: string,
  workerId: string,
  status: "done" | "failed" = "done",
): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ status })
    .where(and(eq(jobs.id, jobId), eq(jobs.workerId, workerId), eq(jobs.status, "running")))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/**
 * Requeue jobs whose lease expired (worker crashed mid-run): any `running` job last
 * heartbeated more than `leaseMs` ago goes back to `queued`. Returns the requeued jobs.
 */
export async function reapExpired(db: Db, leaseMs: number): Promise<Job[]> {
  return db
    .update(jobs)
    .set({ status: "queued", workerId: null, claimedAt: null })
    .where(
      and(
        eq(jobs.status, "running"),
        sql`${jobs.claimedAt} < now() - make_interval(secs => ${leaseMs} / 1000.0)`,
      ),
    )
    .returning();
}

/** Flag every non-terminal job for this run as cancel-requested. */
export async function requestCancel(db: Db, runId: string): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ cancelRequested: true })
    .where(and(eq(jobs.runId, runId), inArray(jobs.status, ["queued", "running"])))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** Whether the worker should abort — polled between nodes. */
export async function isCancelRequested(db: Db, jobId: string): Promise<boolean> {
  const rows = await db
    .select({ cancelRequested: jobs.cancelRequested })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  return rows[0]?.cancelRequested ?? false;
}
