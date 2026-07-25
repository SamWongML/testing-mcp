import { z } from "zod";

/**
 * Fail-fast runtime configuration (validated at boot). Fields beyond the basics are
 * optional until the phase that needs them wires them in (P6 store, P7/P8 server &
 * worker, P10 auth). Invalid config throws immediately rather than failing later.
 */
export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Which role this process plays; the container entrypoint dispatches on it (P7/P8/P11).
   *  `migrate` is the one-off pre-deploy task that applies pending SQL and exits. */
  MODE: z.enum(["server", "worker", "migrate"]).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Postgres system-of-record + queue (P6). */
  DATABASE_URL: z.string().optional(),
  /** The RDS-managed Secrets Manager JSON, injected whole by the ECS task definition (P11).
   *  Used only when `DATABASE_URL` is unset; `resolveDatabaseUrl` derives the URL from it so
   *  no plaintext connection string ever appears in a task definition. */
  DATABASE_SECRET: z.string().optional(),
  /** Which backing the hot task state uses (P11, research §16.2/§18). `postgres` is the
   *  stage-1 collapse — one store, transactional with the queue. `dynamodb` is the
   *  "hundreds of tests" stage: keyed polling + native TTL, off the Postgres write path.
   *  Everything above `@atp/store` is unchanged either way. */
  TASK_STORE: z.enum(["postgres", "dynamodb"]).default("postgres"),
  /** DynamoDB `tasks` table (§16.2). Required when `TASK_STORE=dynamodb`. */
  DYNAMO_TASKS_TABLE: z.string().optional(),
  /** DynamoDB `idempotency` table (§16.2) — dedupes resubmitted runs. Optional; without
   *  it the submit path falls back to keying the run id by the idempotency key. */
  DYNAMO_IDEMPOTENCY_TABLE: z.string().optional(),
  /** Override the DynamoDB endpoint (dynamodb-local). Unset in production, where the SDK
   *  resolves the regional endpoint and the ECS task role's credentials itself. */
  DYNAMO_ENDPOINT: z.string().optional(),
  /** The §11.3 mode-2 escape hatch: when enabled, a submission flagged `isolated` also
   *  launches a one-off Fargate task for that run (the shared queue stays the backstop).
   *  Requires the cluster/task-definition/networking fields below. */
  RUN_TASK_ENABLED: z.stringbool().default(false),
  RUN_TASK_CLUSTER: z.string().optional(),
  /** Worker task-definition family[:revision] the one-off task runs. */
  RUN_TASK_DEFINITION: z.string().optional(),
  /** Comma-separated private subnet ids the one-off task runs in. */
  RUN_TASK_SUBNETS: z.string().optional(),
  /** Comma-separated security group ids for the one-off task. */
  RUN_TASK_SECURITY_GROUPS: z.string().optional(),
  /** Container name inside the worker task definition to override the environment on. */
  RUN_TASK_CONTAINER: z.string().default("worker"),
  /** Which backing artifacts use (P11, §16.3). `local` is the dev/test filesystem store. */
  ARTIFACT_STORE: z.enum(["local", "s3"]).default("local"),
  /** S3 artifact bucket (P6). Required when `ARTIFACT_STORE=s3`. */
  S3_BUCKET: z.string().optional(),
  /** Override the S3 endpoint (MinIO). Unset in production. */
  S3_ENDPOINT: z.string().optional(),
  /** Local artifact directory (dev/tests fallback for the artifact store). */
  ARTIFACT_DIR: z.string().optional(),
  /** Prebuilt manifest to load at boot (P7). When unset, the server compiles the corpus
   *  from source at `TESTS_ROOT` — the dev path (hot-reload via `tsx watch`). */
  MANIFEST_PATH: z.string().optional(),
  /** Root the corpus is compiled from and `ManifestEntry.sourcePath` resolves against, so
   *  `run_test` can import the authored definition (P7). Defaults to the process cwd. */
  TESTS_ROOT: z.string().optional(),
  /** OAuth 2.1 gate on the MCP surface (P10, ADR-007). Off by default so local dev and the
   *  test suite run unauthenticated; production sets `AUTH_ENABLED=true` and the JWKS/issuer/
   *  resource fields below. When on, every tool handler enforces `test:read`/`test:run`. */
  AUTH_ENABLED: z.stringbool().default(false),
  /** The authorization server's issuer URL — advertised in the RFC 9728 metadata and the
   *  required `iss` claim of every access token. */
  AUTH_ISSUER: z.string().optional(),
  /** JWKS endpoint used to validate access-token signatures (`jose` remote key set). */
  AUTH_JWKS_URI: z.string().optional(),
  /** This server's RFC 8707 resource identifier — the required token `aud` and the
   *  `resource` of the RFC 9728 protected-resource metadata document. */
  AUTH_RESOURCE: z.string().optional(),
  /** OpenTelemetry tracing + metrics (P10, §15). Off by default; when on, the server/worker
   *  install a tracer + meter (console exporter locally, OTLP in prod). */
  OTEL_ENABLED: z.stringbool().default(false),
  /** Service name stamped on spans/metrics (OTel `service.name`). */
  SERVICE_NAME: z.string().default("atp"),
  /** Where telemetry is exported (P11). `console` is the dev default; `otlp` pushes to the
   *  collector the observability stack provisions (→ CloudWatch/X-Ray). */
  OTEL_EXPORTER: z.enum(["console", "otlp"]).default("console"),
  /** Base OTLP/HTTP collector endpoint, e.g. `http://localhost:4318`. Required for `otlp`. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
  /** Metric push interval in ms. */
  OTEL_METRIC_EXPORT_INTERVAL_MS: z.coerce.number().int().positive().optional(),
});
export type Config = z.infer<typeof configSchema>;

/** Parse (and validate) configuration from an environment map. Throws on invalid. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return configSchema.parse(env);
}
