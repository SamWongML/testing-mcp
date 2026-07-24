import type { AuthProvider } from "@atp/engine";
import type { Manifest } from "@atp/schema";
import type { ArtifactStore, Db } from "@atp/store";

/**
 * The composition root for the MCP server (research §8, ADR-002). The server is
 * **stateless** — every dependency it needs to answer a request is carried here and
 * injected at boot, never reconstructed per request or kept in mutable module state.
 * Tests build a `ServerContext` directly (real corpus manifest + a `LocalArtifactStore`
 * + no db); `main.ts` builds one from validated config.
 */
export interface ServerContext {
  /** The catalog loaded at boot — backs `list_tests`/`describe_test` and the resources. */
  manifest: Manifest;
  /** Root that `ManifestEntry.sourcePath` resolves against, so `run_test` can import the
   *  authored definition (which carries the functions the manifest strips) and execute it. */
  sourceRoot: string;
  /** Where inline-run artifacts (the canonical `trace.json`) are persisted. */
  artifacts: ArtifactStore;
  /** The `{env}` segment of the artifact key layout (§16.3), e.g. `"mcp"`. */
  artifactEnv: string;
  /** Postgres history. When present, inline runs are recorded and `list_runs` reads it;
   *  when absent (offline/dev), runs still execute + persist artifacts and `list_runs`
   *  reports an empty history — so the surface is always callable. */
  db?: Db;
  /** Auth providers a step's `request.authRef` may select (research §10.3). */
  auth?: AuthProvider[];
}
