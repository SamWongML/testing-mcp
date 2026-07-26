import { z } from "zod";

import { jsonSchemaSchema } from "./params";
import { suiteNodeSchema } from "./suite";
import { authProviderSchema, matrixSchema } from "./test";
import { uniqueById } from "./util";

/**
 * The normalized manifest — the catalog the server actually loads.
 *
 * It contains **no executable functions**: `params` builders become `paramsSchema`
 * (JSON Schema) and `fn` predicates become `{ fnHash }` markers inside nodes. Both
 * tests and suites normalize to the same array of `nodes`, so one entry shape covers
 * the whole catalog. Every entry is addressable; every run records `manifestHash` +
 * `gitSha` for reproducibility.
 */

/** IR contract version stamped onto every emitted manifest. */
export const SCHEMA_VERSION = "1.0" as const;

export const manifestEntrySchema = z.object({
  id: z.string(),
  kind: z.enum(["test", "suite"]),
  version: z.number().int().positive(),
  title: z.string().optional(),
  tags: z.array(z.string()).default([]),
  owner: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** Drives Task augmentation by default. */
  isLongRunning: z.boolean().default(false),
  /** JSON Schema derived from the authored `params` Zod builder. */
  paramsSchema: jsonSchemaSchema.optional(),
  matrix: matrixSchema.optional(),
  /** Resolved env baked in at compile time (a matrix cell resolves its `env` builder
   * per unit; a plain entry carries its static env). Templates like `{{secrets.*}}`
   * stay literal here — they resolve in the engine at run time, so no secret leaks. */
  env: z.record(z.string(), z.unknown()).optional(),
  /** Auth providers this entry's nodes may select by `request.authRef`. Declarative data,
   * so the engine builds them from the manifest alone; credential values stay `{{secrets.*}}`
   * templates and resolve per run. */
  auth: z
    .array(authProviderSchema)
    .default([])
    .refine(uniqueById, "auth provider ids must be unique"),
  /** Normalized DAG: ids, needs, request templates, assertions (incl. fnHash), extracts. */
  nodes: z.array(suiteNodeSchema).min(1).refine(uniqueById, "node ids must be unique"),
  sourcePath: z.string(),
});
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export const manifestSchema = z.object({
  schemaVersion: z.string().default(SCHEMA_VERSION),
  gitSha: z.string(),
  manifestHash: z.string(),
  entries: z.array(manifestEntrySchema).refine(uniqueById, "entry ids must be unique"),
});
export type Manifest = z.infer<typeof manifestSchema>;
