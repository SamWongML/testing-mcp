import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compile } from "@atp/compile";
import { type Config, type Manifest, manifestSchema } from "@atp/schema";
import { LocalArtifactStore } from "@atp/store";

import type { ServerContext } from "./context";

/** The `{env}` segment (§16.3) inline runs are stored under — matches the `envName` the
 *  engine stamps onto an MCP-invoked run, so the artifact key layout stays consistent. */
const ARTIFACT_ENV = "mcp";

/**
 * Load the boot manifest: a prebuilt JSON at `MANIFEST_PATH` (production/CI), else compile
 * the corpus from source at `TESTS_ROOT` (the dev path — `tsx watch` re-runs this on change
 * for hot-reload). Either source is schema-validated, so a malformed manifest fails fast at
 * boot rather than at first request.
 */
async function loadManifest(config: Config, sourceRoot: string): Promise<Manifest> {
  if (config.MANIFEST_PATH) {
    const raw = await readFile(resolve(config.MANIFEST_PATH), "utf8");
    return manifestSchema.parse(JSON.parse(raw));
  }
  return compile({ root: sourceRoot });
}

/**
 * Build the stateless {@link ServerContext} from validated config (research §8, ADR-002).
 * Resolves the manifest source, the artifact store, and the roots the tools need — nothing
 * per-request. The db is injected by the entrypoint (the established seam: tests build a
 * context with a throwaway db), so this stays offline and free of connection lifecycle.
 */
export async function buildContext(config: Config): Promise<ServerContext> {
  const sourceRoot = resolve(config.TESTS_ROOT ?? process.cwd());
  const manifest = await loadManifest(config, sourceRoot);
  const artifactDir = config.ARTIFACT_DIR ?? resolve(sourceRoot, ".atp/artifacts");
  return {
    manifest,
    sourceRoot,
    artifacts: new LocalArtifactStore(artifactDir),
    artifactEnv: ARTIFACT_ENV,
  };
}
