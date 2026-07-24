import { resolve } from "node:path";

import { importDef } from "@atp/compile";
import { expandUnits, isSuite, type ProgressUpdate, runSuite, runTest } from "@atp/engine";
import type { ExecutionResult, ManifestEntry } from "@atp/schema";

import type { ServerContext } from "./context";

/**
 * The shared execution seam (research §10.3, §12). Imports the authored definition (which
 * carries the functions the manifest strips), enumerates its matrix cell, and dispatches to
 * `runTest`/`runSuite` — the single code path used by both the synchronous inline `run_test`
 * tool and the asynchronous P8 worker. The worker adds `signal` (cancellation), `runId`
 * (so the durable task and the engine result share an id), and `onProgress` (k/n ticks).
 */
export interface ExecuteOptions {
  params?: Record<string, unknown>;
  /** Env overrides merged over the entry's baked-in env (e.g. `{ baseUrl }`). */
  env?: Record<string, string>;
  /** Abort between/within nodes to cancel an in-flight run. */
  signal?: AbortSignal;
  /** The run id to stamp on the result — defaults to a fresh UUID from the engine. */
  runId?: string;
  /** Node-settled progress ticks (the worker forwards them to the task store + MCP). */
  onProgress?: (update: ProgressUpdate) => void;
}

/** Execute one manifest entry (test or suite) end-to-end and return its `ExecutionResult`. */
export async function executeEntry(
  ctx: ServerContext,
  entry: ManifestEntry,
  opts: ExecuteOptions = {},
): Promise<ExecutionResult> {
  const def = await importDef(resolve(ctx.sourceRoot, entry.sourcePath));
  // Reuse the engine's cell enumeration so this run's per-cell env/matrix match the manifest
  // exactly — no re-parsing the id string (which loses value types and separators).
  const unit = expandUnits(def).find((u) => u.id === entry.id);
  const common = {
    env: { ...(unit?.env ?? {}), ...(opts.env ?? {}) },
    matrix: unit?.matrix ?? {},
    auth: ctx.auth,
    entryId: entry.id,
    envName: ctx.artifactEnv,
    manifestHash: ctx.manifest.manifestHash,
    gitSha: ctx.manifest.gitSha,
    signal: opts.signal,
    runId: opts.runId,
    onProgress: opts.onProgress,
  };

  if (isSuite(def)) {
    // A manifest suite must resolve to a suite module — catch a manifest/module mismatch
    // rather than mis-dispatching to the single-test runner.
    if (entry.kind !== "suite") throw new Error(`"${entry.id}" resolved to a suite, not a test`);
    return runSuite(def, common);
  }
  if (entry.kind !== "test") throw new Error(`"${entry.id}" resolved to a test, not a suite`);
  return runTest(def, { ...common, params: opts.params });
}
