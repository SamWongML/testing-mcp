import { z } from "zod";

import { jsonSchemaSchema } from "./params";
import { suiteNodeSchema } from "./suite";
import { matrixSchema } from "./test";

/**
 * The normalized manifest — the catalog the server actually loads (research §7.4).
 *
 * It contains **no executable functions**: `params` builders become `paramsSchema`
 * (JSON Schema) and `fn` predicates become `{ fnHash }` markers inside nodes. Both
 * tests and suites normalize to the same array of `nodes`, so one entry shape covers
 * the whole catalog. Every entry is addressable; every run records `manifestHash` +
 * `gitSha` for reproducibility (§21).
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
  /** Drives Task augmentation by default (P8). */
  isLongRunning: z.boolean().default(false),
  /** JSON Schema derived from the authored `params` Zod builder. */
  paramsSchema: jsonSchemaSchema.optional(),
  matrix: matrixSchema.optional(),
  /** Normalized DAG: ids, needs, request templates, assertions (incl. fnHash), extracts. */
  nodes: z.array(suiteNodeSchema).min(1),
  sourcePath: z.string(),
});
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;

export const manifestSchema = z.object({
  schemaVersion: z.string().default(SCHEMA_VERSION),
  gitSha: z.string(),
  manifestHash: z.string(),
  entries: z.array(manifestEntrySchema),
});
export type Manifest = z.infer<typeof manifestSchema>;
