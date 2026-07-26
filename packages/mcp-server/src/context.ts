import type { Manifest } from "@atp/schema";
import type { ArtifactStore, Db, TaskStoreProvider } from "@atp/store";

import type { Authenticator } from "./auth";
import type { Logger } from "./logging";
import type { RunTaskLauncher } from "./run-task";
import type { Telemetry } from "./telemetry";

/** OAuth gate for the MCP surface. Present ⇒ auth is enabled: the HTTP layer
 * verifies bearer tokens (rejecting 401) and every tool handler enforces `test:read`/`test:run`.
 *  Absent ⇒ dev/test mode, unauthenticated. `issuer`/`resource` back the RFC 9728 metadata. */
export interface AuthContext {
  authenticator: Authenticator;
  issuer: string;
  resource: string;
}

/**
 * The composition root for the MCP server. The server is
 * **stateless** — every dependency it needs to answer a request is carried here and
 * injected at boot, never reconstructed per request or kept in mutable module state.
 * Tests build a `ServerContext` directly (real corpus manifest + a `LocalArtifactStore`
 * + no db); `main.ts` builds one from validated config.
 */
export interface ServerContext {
  /** The catalog loaded at boot — backs `list_tests`/`describe_test` and the resources. */
  manifest: Manifest;
  /** Root that `ManifestEntry.sourcePath` resolves against, so `run_test` can import the
   * authored definition (which carries the functions the manifest strips) and execute it. */
  sourceRoot: string;
  /** Where inline-run artifacts (the canonical `trace.json`) are persisted. */
  artifacts: ArtifactStore;
  /** The `{env}` segment of the artifact key layout, e.g. `"mcp"`. */
  artifactEnv: string;
  /** The `{{secrets.*}}` bag every run resolves credentials against, collected from
   * `ATP_SECRET_*` at boot. Empty when none are configured — a test that needs one then
   * errors on the unresolved template rather than sending a blank credential. */
  secrets: Record<string, string>;
  /** Postgres history. When present, inline runs are recorded and `list_runs` reads it;
   * when absent (offline/dev), runs still execute + persist artifacts and `list_runs`
   * reports an empty history — so the surface is always callable. */
  db?: Db;
  /** Which backing the hot task state uses. Absent ⇒ the stage-1 Postgres
   * store, transactional with the queue. Present ⇒ whatever config selected, typically
   * DynamoDB. Nothing else in this package is backend-aware: it all goes through
   * `taskStoreFor(ctx, db)`. */
  taskStore?: TaskStoreProvider;
  /** Launches a dedicated Fargate task for an isolated run (mode 2). Present only
   * when the escape hatch is configured; absent ⇒ every run goes to the worker pool. */
  runTaskLauncher?: RunTaskLauncher;
  /** OAuth authN/Z gate. When present, the surface is authenticated + scope-gated. */
  authn?: AuthContext;
  /** Structured logger. When present, the worker/request paths log correlated lines;
   * when absent, they run quietly (keeps the offline/test path free of log noise). */
  logger?: Logger;
  /** OTel tracer + meter. When present, runs emit spans + metrics. */
  telemetry?: Telemetry;
}
