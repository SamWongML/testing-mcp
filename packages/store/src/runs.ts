import type { ExecutionResult } from "@atp/schema";
import { and, desc, eq, gte } from "drizzle-orm";

import type { Db } from "./db/client";
import { assertionResults, runs, stepResults } from "./db/schema";

/**
 * Run history — the record (research §16.1). `recordRun` persists an `ExecutionResult`
 * as a `runs` row plus its `step_results` and `assertion_results` in one transaction;
 * `listRuns` is the flakiness-friendly history query the MCP `list_runs` tool serves.
 */

export type Run = typeof runs.$inferSelect;
export type StepResultRow = typeof stepResults.$inferSelect;
export type AssertionResultRow = typeof assertionResults.$inferSelect;

export interface RecordRunMeta {
  /** Principal that invoked the run (audit / attribution). */
  invokedBy?: string;
  /** Where the artifacts were stored (pointer, not blob). */
  artifactUri?: string;
}

const toInt = (n: number | undefined): number | null => (n === undefined ? null : Math.round(n));

export async function recordRun(
  db: Db,
  result: ExecutionResult,
  meta: RecordRunMeta = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(runs).values({
      id: result.runId,
      entryId: result.entryId,
      manifestHash: result.manifestHash ?? null,
      status: result.status,
      params: result.params ?? null,
      env: result.env ?? null,
      startedAt: new Date(result.startedAt),
      finishedAt: result.finishedAt ? new Date(result.finishedAt) : null,
      durationMs: toInt(result.durationMs),
      artifactUri: meta.artifactUri ?? null,
      invokedBy: meta.invokedBy ?? null,
    });

    for (const step of result.steps) {
      await tx.insert(stepResults).values({
        runId: result.runId,
        nodeId: step.id,
        status: step.status,
        timingMs: toInt(step.timingMs),
        attempts: step.attempts,
      });
      if (step.assertions.length > 0) {
        await tx.insert(assertionResults).values(
          step.assertions.map((a, idx) => ({
            runId: result.runId,
            nodeId: step.id,
            idx,
            ok: a.ok,
            message: a.message ?? null,
          })),
        );
      }
    }
  });
}

export interface ListRunsFilter {
  entryId?: string;
  status?: ExecutionResult["status"];
  /** Only runs started at/after this instant. */
  since?: Date;
  limit?: number;
}

/** History query, newest first — filter by test, status, and recency (§16.1). */
export async function listRuns(db: Db, filter: ListRunsFilter = {}): Promise<Run[]> {
  const conds = [];
  if (filter.entryId !== undefined) conds.push(eq(runs.entryId, filter.entryId));
  if (filter.status !== undefined) conds.push(eq(runs.status, filter.status));
  if (filter.since !== undefined) conds.push(gte(runs.startedAt, filter.since));

  return db
    .select()
    .from(runs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(runs.startedAt))
    .limit(filter.limit ?? 100);
}

export interface RunDetail {
  run: Run;
  steps: StepResultRow[];
  assertions: AssertionResultRow[];
}

/** Fetch a run with its step + assertion rows, or null if absent. */
export async function getRun(db: Db, runId: string): Promise<RunDetail | null> {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return null;
  const steps = await db.select().from(stepResults).where(eq(stepResults.runId, runId));
  const assertions = await db
    .select()
    .from(assertionResults)
    .where(eq(assertionResults.runId, runId));
  return { run, steps, assertions };
}
