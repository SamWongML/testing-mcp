import type { ExecutionResult } from "@atp/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";

import type { Db } from "./db/client";
import { assertionResults, runs, stepResults } from "./db/schema";
import { decodeKeysetCursor, encodeKeysetCursor, isoSortKey } from "./keyset";

/**
 * Run history — the record. `recordRun` persists an `ExecutionResult`
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
      gitSha: result.gitSha ?? null,
      status: result.status,
      params: result.params ?? null,
      env: result.env ?? null,
      startedAt: new Date(result.startedAt),
      finishedAt: result.finishedAt ? new Date(result.finishedAt) : null,
      durationMs: toInt(result.durationMs),
      artifactUri: meta.artifactUri ?? null,
      invokedBy: meta.invokedBy ?? null,
    });

    // Batched: one insert for all steps, one for all assertions (Drizzle rejects an
    // empty `.values([])`, so guard each on length).
    if (result.steps.length > 0) {
      await tx.insert(stepResults).values(
        result.steps.map((step) => ({
          runId: result.runId,
          nodeId: step.id,
          status: step.status,
          timingMs: toInt(step.timingMs),
          attempts: step.attempts,
        })),
      );
    }
    const assertionRows = result.steps.flatMap((step) =>
      step.assertions.map((a, idx) => ({
        runId: result.runId,
        nodeId: step.id,
        idx,
        ok: a.ok,
        message: a.message ?? null,
      })),
    );
    if (assertionRows.length > 0) {
      await tx.insert(assertionResults).values(assertionRows);
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

/** History query, newest first — filter by test, status, and recency. Capped at `limit`;
 * use {@link listRunsPage} to reach history beyond the first page. */
export async function listRuns(db: Db, filter: ListRunsFilter = {}): Promise<Run[]> {
  return (await listRunsPage(db, filter)).runs;
}

export interface ListRunsPage {
  runs: Run[];
  /** Absent means "end of results" — the protocol's own signal. */
  nextCursor?: string;
}

/** `started_at` is nullable, so nulls collapse to the epoch — they sort last in a
 * newest-first ordering, and the composite key stays total. */
const runSortKey = isoSortKey(runs.startedAt, sql`'epoch'::timestamptz`);

/** One page of history, newest first, plus the cursor for the next. Keyset over
 * `(started_at, id)` — stable as runs are recorded mid-traversal, unlike an offset. */
export async function listRunsPage(
  db: Db,
  filter: ListRunsFilter & { cursor?: string } = {},
): Promise<ListRunsPage> {
  const conds = [];
  if (filter.entryId !== undefined) conds.push(eq(runs.entryId, filter.entryId));
  if (filter.status !== undefined) conds.push(eq(runs.status, filter.status));
  if (filter.since !== undefined) conds.push(gte(runs.startedAt, filter.since));
  const after = decodeKeysetCursor(filter.cursor);
  // Row-wise comparison is the keyset predicate for `(sortKey DESC, id DESC)` — one
  // condition, and total because `id` is the primary key.
  if (after) conds.push(sql`(${runSortKey}, ${runs.id}) < (${after.sortKey}, ${after.tiebreaker})`);

  const limit = Math.min(filter.limit ?? DEFAULT_RUN_PAGE_SIZE, MAX_RUN_PAGE_SIZE);
  // Over-fetch by one: the extra row is how we know more remain without a second query.
  const rows = await db
    .select({ run: runs, sortKey: runSortKey })
    .from(runs)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(runSortKey), desc(runs.id)) // id tiebreaks equal timestamps → stable
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const more = rows.length > limit && last !== undefined;
  return {
    runs: page.map((r) => r.run),
    ...(more ? { nextCursor: encodeKeysetCursor(last.sortKey, last.run.id) } : {}),
  };
}

/** Rows per page when the caller doesn't say. */
export const DEFAULT_RUN_PAGE_SIZE = 100;
export const MAX_RUN_PAGE_SIZE = 1000;

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
