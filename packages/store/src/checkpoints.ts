import { asc, eq, lt, sql } from "drizzle-orm";

import type { StepResult } from "@atp/schema";

import type { Db } from "./db/client";
import { runCheckpoints } from "./db/schema";

/**
 * Per-node run checkpoints — what makes a re-claimed run resumable.
 *
 * The engine awaits a checkpoint write before letting any dependent node start, so a row
 * here means "this node definitely executed". A worker that loses its lease mid-run seeds
 * the next attempt from these rows instead of re-executing (and re-firing) everything.
 *
 * Operational state, deliberately separate from `runs`/`step_results`: those are history,
 * written once from a finalized `ExecutionResult`, and a run in flight has no terminal
 * status to record there. Rows are pruned on every terminal write, with
 * {@link sweepExpiredCheckpoints} as the backstop for a process that died before pruning.
 *
 * Payloads are redacted `StepResult`s — they passed the engine's `redact()` before reaching
 * this module, upholding redact-before-persist.
 */

/** Backstop TTL for rows orphaned by a process that died between the terminal write and its
 * prune. A live run that settles no node for this long is not realistic, so age alone is a
 * safe deletion criterion and needs no join against `jobs`/`tasks`. */
export const DEFAULT_CHECKPOINT_TTL_MS = 6 * 60 * 60 * 1000;

export interface PutCheckpointInput {
  runId: string;
  nodeId: string;
  payload: StepResult;
}

/** Durably record one settled node. Upsert on `(runId, nodeId)`: under normal operation a
 * node is checkpointed once per run, so this is defensive rather than load-bearing. */
export async function putCheckpoint(db: Db, input: PutCheckpointInput): Promise<void> {
  await db
    .insert(runCheckpoints)
    .values({ runId: input.runId, nodeId: input.nodeId, payload: input.payload })
    .onConflictDoUpdate({
      target: [runCheckpoints.runId, runCheckpoints.nodeId],
      set: { payload: input.payload, createdAt: sql`now()` },
    });
}

/** Every checkpoint for a run, keyed by node id — the seed a resumed attempt runs from. */
export async function getCheckpoints(db: Db, runId: string): Promise<Record<string, StepResult>> {
  const rows = await db
    .select()
    .from(runCheckpoints)
    .where(eq(runCheckpoints.runId, runId))
    .orderBy(asc(runCheckpoints.createdAt));
  const out: Record<string, StepResult> = {};
  for (const row of rows) out[row.nodeId] = row.payload as StepResult;
  return out;
}

/** Drop a run's checkpoints. Called on every terminal path; a terminal run is never resumed,
 * so leftover rows are inert and callers may treat a failure here as best-effort. */
export async function pruneCheckpoints(db: Db, runId: string): Promise<number> {
  const rows = await db
    .delete(runCheckpoints)
    .where(eq(runCheckpoints.runId, runId))
    .returning({ nodeId: runCheckpoints.nodeId });
  return rows.length;
}

/** TTL backstop, mirroring the task sweep the worker already runs. */
export async function sweepExpiredCheckpoints(
  db: Db,
  maxAgeMs: number = DEFAULT_CHECKPOINT_TTL_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeMs);
  const rows = await db
    .delete(runCheckpoints)
    .where(lt(runCheckpoints.createdAt, cutoff))
    .returning({ nodeId: runCheckpoints.nodeId });
  return rows.length;
}
