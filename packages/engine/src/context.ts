import type { RequestSpec } from "@atp/schema";

/**
 * The scoped variable bag a run resolves templates against (research §10.1).
 *
 * `nodes` is keyed by node id → the vars that node published via `extract`. It is
 * empty for a single test's first step and grows as later steps/nodes run, so the
 * P3 DAG runner reuses this exact shape for `{{nodes.X.var}}` resolution.
 */
export interface RunContext {
  env: Record<string, unknown>;
  params: Record<string, unknown>;
  secrets: Record<string, string>;
  matrix: Record<string, unknown>;
  nodes: Record<string, Record<string, unknown>>;
  /** Latest published extracts, flattened — addressed as `{{vars.*}}`. */
  vars: Record<string, unknown>;
  /** Cooperative cancellation: checked between nodes and passed to the HTTP client. */
  signal?: AbortSignal;
}

/** A response as the engine sees it — the object assertions and extracts address. */
export interface EngineResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  timingMs?: number;
}

/** A request whose `{{…}}` templates have been resolved and is ready to send. */
export type ResolvedRequest = RequestSpec;
