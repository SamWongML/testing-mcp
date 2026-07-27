import { randomUUID } from "node:crypto";

import { and, eq, inArray, lt, sql } from "drizzle-orm";

import type { Db } from "./db/client";
import { jobs } from "./db/schema";

/**
 * Durable job queue on Postgres — the no-broker dispatch pattern ( * ). A worker claims exactly one job with `FOR UPDATE SKIP LOCKED` so many
 * workers contend safely; a heartbeat keeps the lease fresh and a reaper requeues
 * jobs whose worker died. Cancellation is a `cancel_requested` flag the worker polls
 * between nodes.
 */

export type Job = typeof jobs.$inferSelect;
/** `dead_letter` is terminal like `done`/`failed`: the job exhausted `max_attempts` and is
 * never claimable again, so a job that reliably kills its worker stops looping. */
export type JobStatus = "queued" | "running" | "done" | "failed" | "dead_letter";

export interface EnqueueInput {
  /** The run this job will execute (the row the worker records history under). */
  runId?: string;
  /** Opaque run spec (entry id + params + env) the worker needs to execute. */
  spec?: unknown;
  /** Higher runs first; ties broken by age. */
  priority?: number;
  /** Delay availability until this time (retry/backoff); defaults to now. */
  runAfter?: Date;
  /** Lease expiries tolerated before dead-lettering; defaults to the column default (5). */
  maxAttempts?: number;
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
      maxAttempts: input.maxAttempts, // undefined → DB default
    })
    .returning();
  return row!;
}

export interface ClaimOptions {
  /** Claim only this run's job. Used by the mode-2 one-off worker, which exists to
   * give one *particular* run a dedicated container — an untargeted claim would let it
   * pick up whatever is at the head of the queue instead. `null` if that job is no longer
   * claimable (a pooled worker got there first), which is a clean exit, not an error. */
  runId?: string;
}

/**
 * Claim the highest-priority ready job, or `null` if none. The `SELECT … FOR UPDATE
 * SKIP LOCKED` inside the transaction row-locks the pick so concurrent claimers skip
 * it and take the next one — no job is ever claimed twice. The follow-up UPDATE returns
 * the fully typed row.
 */
export async function claim(
  db: Db,
  workerId: string,
  opts: ClaimOptions = {},
): Promise<Job | null> {
  return db.transaction(async (tx) => {
    const targeted = opts.runId !== undefined;
    const picked = await tx.execute<{ id: string }>(sql`
      SELECT id FROM jobs
      WHERE status = 'queued' AND run_after <= now()
        ${targeted ? sql`AND run_id = ${opts.runId}` : sql``}
      ORDER BY priority DESC, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `);
    const id = picked.rows[0]?.id;
    if (!id) return null;
    const [row] = await tx
      .update(jobs)
      .set({
        status: "running",
        workerId,
        claimedAt: sql`now()`,
        // Sticky: set on the first claim and preserved across every reap/reclaim, so a
        // resumed run can report when it *originally* started.
        firstClaimedAt: sql`COALESCE(${jobs.firstClaimedAt}, now())`,
      })
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
 * Backoff before a requeued job becomes claimable again: `5 * (2^attempts - 1)` seconds,
 * capped at 5 minutes — 0s, 5s, 15s, 35s, …
 *
 * The first retry is deliberately immediate: a single lease expiry is usually a one-off
 * (a deploy, an OOM, a lost node) and delaying it would just add latency. It is the
 * *repeat* crash that needs spacing, or a job that kills its worker instantly would burn
 * its whole attempt budget in a fraction of a second and dead-letter before anyone could
 * observe it.
 */
const BACKOFF_BASE_SECONDS = 5;
const BACKOFF_CAP_SECONDS = 300;

/**
 * Requeue jobs whose lease expired (worker crashed mid-run), counting the crash.
 *
 * Below `max_attempts` the job returns to `queued` behind an exponential backoff — the first
 * production use of the long-modelled `run_after` column. At the ceiling it is
 * **dead-lettered** instead: `worker_id`/`claimed_at` are frozen for forensics and the job is
 * never claimable again, so a poison job stops consuming a worker slot forever while its
 * client polls a `working` task that will never settle. The caller finalizes the task row for
 * any returned job whose status came back `dead_letter`.
 *
 * Returns every job it touched, requeued and dead-lettered alike.
 */
export async function reapExpired(db: Db, leaseMs: number): Promise<Job[]> {
  // `attempts + 1` is this reap's count; every branch below keys off it, so the CASEs stay
  // consistent with the single increment.
  const exhausted = sql`${jobs.attempts} + 1 >= ${jobs.maxAttempts}`;
  return db
    .update(jobs)
    .set({
      attempts: sql`${jobs.attempts} + 1`,
      status: sql`CASE WHEN ${exhausted} THEN 'dead_letter' ELSE 'queued' END`,
      workerId: sql`CASE WHEN ${exhausted} THEN ${jobs.workerId} ELSE NULL END`,
      claimedAt: sql`CASE WHEN ${exhausted} THEN ${jobs.claimedAt} ELSE NULL END`,
      runAfter: sql`CASE WHEN ${exhausted} THEN ${jobs.runAfter} ELSE now() + make_interval(
        secs => LEAST(${BACKOFF_BASE_SECONDS} * (power(2, ${jobs.attempts}) - 1), ${BACKOFF_CAP_SECONDS})
      ) END`,
      lastError: sql`CASE WHEN ${exhausted}
        THEN 'lease expired after ' || (${jobs.attempts} + 1) || ' attempt(s) — dead-lettered'
        ELSE 'lease expired (attempt ' || (${jobs.attempts} + 1) || ')' END`,
    })
    .where(
      and(
        eq(jobs.status, "running"),
        sql`${jobs.claimedAt} < now() - make_interval(secs => ${leaseMs} / 1000.0)`,
      ),
    )
    .returning();
}

/** Terminal statuses a job never leaves — the sweep's deletion set. */
const TERMINAL_STATUSES = ["done", "failed", "dead_letter"];

/**
 * Delete terminal jobs older than `maxAgeMs`. The queue is operational state, but nothing
 * ever removed a settled row, so every job's `spec` jsonb (params, env, trace context)
 * accumulated forever in the table on the hot claim path. The run's history (`runs`,
 * `step_results`) and its trace artifact are untouched — those are the record; this is the
 * envelope work arrived in.
 */
export async function sweepTerminalJobs(db: Db, maxAgeMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const rows = await db
    .delete(jobs)
    .where(and(inArray(jobs.status, TERMINAL_STATUSES), lt(jobs.createdAt, cutoff)))
    .returning({ id: jobs.id });
  return rows.length;
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

/**
 * The number of ready-to-claim jobs — `queued` and past their `run_after`. This is the
 * `queue_depth` metric that drives worker autoscaling: it counts work waiting for a
 * worker, excluding claimed (`running`) and future-scheduled jobs.
 */
export async function queueDepth(db: Db): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.status, "queued"), sql`${jobs.runAfter} <= now()`));
  return rows[0]?.n ?? 0;
}

/** Whether the worker should abort — polled between nodes. */
export async function isCancelRequested(db: Db, jobId: string): Promise<boolean> {
  const rows = await db
    .select({ cancelRequested: jobs.cancelRequested })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  return rows[0]?.cancelRequested ?? false;
}
