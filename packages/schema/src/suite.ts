import { z } from "zod";

import type { AuthoredStep } from "./test";
import { matrixSchema, stepSchema } from "./test";

/**
 * Suites compose tests/steps into a DAG (research §7.2 / §12).
 *
 * Authored suites key nodes by id (`nodes: { auth: useTest(...), ... }`) and a node
 * may be a reused test, a reused step, or an inline step. The normalizer inlines all
 * three into concrete request nodes, so the *normalized* node here is simply a step
 * with explicit `needs` edges — the array form the manifest loads.
 */

/** A normalized suite node = a step plus its dependency edges. */
export const suiteNodeSchema = stepSchema;
export type SuiteNode = z.infer<typeof suiteNodeSchema>;

export const suiteSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  title: z.string().optional(),
  tags: z.array(z.string()).default([]),
  owner: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  env: z.record(z.string(), z.unknown()).optional(),
  matrix: matrixSchema.optional(),
  nodes: z.array(suiteNodeSchema).min(1),
});
export type Suite = z.infer<typeof suiteSchema>;

// ---------------------------------------------------------------------------
// Authored node union (function-carrying / by-reference; not serializable).
// ---------------------------------------------------------------------------

export interface UseTestNode {
  use: "test";
  /** Stable id of the reused test. */
  testId: string;
  /** Override the reused test's params. */
  params?: Record<string, unknown>;
  needs?: string[];
}

export interface UseStepNode {
  use: "step";
  /** Stable id of the reused shared step. */
  stepId: string;
  /** Bind the reused step's inputs (e.g. `{ token: "{{nodes.auth.authToken}}" }`). */
  with?: Record<string, unknown>;
  needs?: string[];
}

/** An inline node is just an authored step. */
export type InlineNode = AuthoredStep;

export type AuthoredSuiteNode = UseTestNode | UseStepNode | InlineNode;

export interface AuthoredSuite {
  id: string;
  version: number;
  title?: string;
  tags?: string[];
  owner?: string;
  timeoutMs?: number;
  env?: Record<string, unknown>;
  matrix?: Record<string, unknown[]>;
  /** Authored nodes are keyed by node id. */
  nodes: Record<string, AuthoredSuiteNode>;
}
