import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compile } from "@atp/compile";
import { type Config, type Manifest, manifestSchema, secretsFromEnv } from "@atp/schema";
import { createArtifactStore } from "@atp/store";

import { createAuthenticator } from "./auth";
import type { AuthContext, ServerContext } from "./context";
import { createEcsRunTaskLauncher, type RunTaskLauncher } from "./run-task";

/** The `{env}` segment inline runs are stored under — matches the `envName` the
 * engine stamps onto an MCP-invoked run, so the artifact key layout stays consistent. */
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
 * Build the OAuth {@link AuthContext} from config, or `undefined` when
 * `AUTH_ENABLED` is off (the dev/test default). Enabling auth requires the issuer, this
 * server's resource identifier, and a JWKS endpoint — a missing one fails fast at boot. The
 * remote key set is lazy (no I/O until the first token verify), so this stays offline-safe.
 */
export function buildAuthContext(config: Config): AuthContext | undefined {
  if (!config.AUTH_ENABLED) return undefined;
  const { AUTH_ISSUER: issuer, AUTH_RESOURCE: resource, AUTH_JWKS_URI: jwksUri } = config;
  if (!issuer || !resource || !jwksUri) {
    throw new Error(
      "AUTH_ENABLED requires AUTH_ISSUER, AUTH_RESOURCE, and AUTH_JWKS_URI to be set",
    );
  }
  return { issuer, resource, authenticator: createAuthenticator({ issuer, resource, jwksUri }) };
}

/**
 * Build the mode-2 launcher from config, or `undefined` when the escape hatch is off
 * (the default). Enabling it without the cluster/task-definition/networking fields is a
 * configuration error, so it fails fast at boot rather than at the first isolated run.
 */
export function buildRunTaskLauncher(config: Config): RunTaskLauncher | undefined {
  if (!config.RUN_TASK_ENABLED) return undefined;
  const {
    RUN_TASK_CLUSTER: cluster,
    RUN_TASK_DEFINITION: taskDefinition,
    RUN_TASK_SUBNETS: subnets,
    RUN_TASK_SECURITY_GROUPS: securityGroups,
  } = config;
  if (!cluster || !taskDefinition || !subnets || !securityGroups) {
    throw new Error(
      "RUN_TASK_ENABLED requires RUN_TASK_CLUSTER, RUN_TASK_DEFINITION, RUN_TASK_SUBNETS, and RUN_TASK_SECURITY_GROUPS",
    );
  }
  const list = (v: string): string[] =>
    v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  return createEcsRunTaskLauncher({
    cluster,
    taskDefinition,
    subnets: list(subnets),
    securityGroups: list(securityGroups),
    containerName: config.RUN_TASK_CONTAINER,
  });
}

/**
 * Build the stateless {@link ServerContext} from validated config.
 * Resolves the manifest source, the artifact store, the auth gate, and the roots the tools
 * need — nothing per-request. The db, logger, and telemetry are injected by the entrypoint
 * (the established seam: tests build a context with a throwaway db + in-memory exporters), so
 * this stays offline and free of connection/provider lifecycle.
 */
export async function buildContext(config: Config): Promise<ServerContext> {
  const sourceRoot = resolve(config.TESTS_ROOT ?? process.cwd());
  const manifest = await loadManifest(config, sourceRoot);
  // Local filesystem by default; S3 when `ARTIFACT_STORE=s3`. Constructing an
  // S3 client performs no I/O, so this stays offline-safe.
  const artifacts = createArtifactStore(config, resolve(sourceRoot, ".atp/artifacts"));
  return {
    manifest,
    sourceRoot,
    artifacts,
    artifactEnv: ARTIFACT_ENV,
    secrets: secretsFromEnv(process.env),
    authn: buildAuthContext(config),
    runTaskLauncher: buildRunTaskLauncher(config),
  };
}
