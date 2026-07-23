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
  /** Auth providers keyed by id; a request's `authRef` selects one (research §10.3). */
  auth: Record<string, AuthProvider>;
  /** Per-run access-token cache for token-fetching providers (oauth2 client-credentials). */
  authCache: Map<string, Promise<string>>;
  /** Cooperative cancellation: checked between nodes and passed to the HTTP client. */
  signal?: AbortSignal;
}

/**
 * A pluggable authentication provider (research §10.1/§10.3). `apply` receives a
 * template-resolved request and returns it with credentials injected; the runner then
 * re-resolves templates in any values the provider added (e.g. `{{secrets.*}}`).
 */
export interface AuthProvider {
  id: string;
  apply(request: RequestSpec, ctx: RunContext): RequestSpec | Promise<RequestSpec>;
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
