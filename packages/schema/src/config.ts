import { z } from "zod";

/**
 * Fail-fast runtime configuration (validated at boot). Fields beyond the basics are
 * optional until the phase that needs them wires them in (P6 store, P7/P8 server &
 * worker, P10 auth). Invalid config throws immediately rather than failing later.
 */
export const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Which process this is; consumed by the server/worker entrypoints (P7/P8). */
  MODE: z.enum(["server", "worker"]).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Postgres system-of-record + queue (P6). */
  DATABASE_URL: z.string().optional(),
  /** S3 artifact bucket (P6). */
  S3_BUCKET: z.string().optional(),
  /** Local artifact directory (dev/tests fallback for the artifact store). */
  ARTIFACT_DIR: z.string().optional(),
});
export type Config = z.infer<typeof configSchema>;

/** Parse (and validate) configuration from an environment map. Throws on invalid. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return configSchema.parse(env);
}
