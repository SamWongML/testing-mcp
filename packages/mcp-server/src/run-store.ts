import type { ExecutionResult } from "@atp/schema";
import { artifactKey, recordRun } from "@atp/store";

import type { ServerContext } from "./context";

/**
 * Inline-run persistence (research §16). A completed run's canonical `trace.json` is the
 * artifact everything else renders from; it lands at the store's date-partitioned key
 * layout (§16.3). Because {@link ArtifactStore} has no `list`, resolving a run from its id
 * alone (`get_report`, the `run://` resources) needs an index — so we also write a tiny
 * runId → traceKey pointer. Both live in the injected store, so the request path stays
 * stateless (ADR-002): nothing is remembered in memory between requests.
 *
 * The engine already redacts the request/response snapshots inside an `ExecutionResult`
 * before returning it, so persisting the result as-is upholds redact-before-persist.
 */

export interface PersistedRun {
  /** The date-partitioned key the trace blob was stored under. */
  traceKey: string;
  /** A fetchable location reference for the trace (file:// locally, s3:// in P11). */
  traceUri: string;
}

/** The env-scoped, runId-addressable pointer key that resolves back to a trace. */
function pointerKey(ctx: ServerContext, runId: string): string {
  return `${ctx.artifactEnv}/index/run/${runId}`;
}

/** Persist a run's trace + pointer, and record history when a db is configured. */
export async function persistRun(
  ctx: ServerContext,
  result: ExecutionResult,
): Promise<PersistedRun> {
  const traceKey = artifactKey({
    env: ctx.artifactEnv,
    runId: result.runId,
    name: "trace.json",
    now: new Date(result.startedAt),
  });
  const { uri: traceUri } = await ctx.artifacts.put(
    traceKey,
    JSON.stringify(result),
    "application/json",
  );
  await ctx.artifacts.put(pointerKey(ctx, result.runId), traceKey, "text/plain");
  if (ctx.db) await recordRun(ctx.db, result, { artifactUri: traceUri });
  return { traceKey, traceUri };
}

/** Load a stored run's `ExecutionResult` by id, via the pointer index. Throws a
 *  client-facing error if the run is unknown (no pointer written). */
export async function loadTrace(ctx: ServerContext, runId: string): Promise<ExecutionResult> {
  let traceKey: string;
  try {
    traceKey = (await ctx.artifacts.get(pointerKey(ctx, runId))).toString("utf8");
  } catch {
    throw new Error(`No run with id "${runId}"`);
  }
  const raw = await ctx.artifacts.get(traceKey);
  return JSON.parse(raw.toString("utf8")) as ExecutionResult;
}
