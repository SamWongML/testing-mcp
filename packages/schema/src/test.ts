import { z } from "zod";

import { uniqueById } from "./util";

/**
 * Normalized (serializable) test IR. See research §7.1 / §10.1.
 *
 * "Authored" forms (what a human writes in `defineTest`) carry real functions —
 * `fn` predicates and a `params` builder. The normalizer (engine, P2/P4) replaces
 * those with serializable markers: `fn` → `{ fnHash }`, `params` → JSON Schema.
 * The schemas below describe the *normalized* form that lands in the manifest;
 * authored-only types live at the bottom of this file.
 */

export const httpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
export type HttpMethod = z.infer<typeof httpMethodSchema>;

export const requestSchema = z.object({
  method: httpMethodSchema,
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  authRef: z.string().optional(),
});
export type RequestSpec = z.infer<typeof requestSchema>;

export const assertionOpSchema = z.enum([
  "eq",
  "neq",
  "gt",
  "lt",
  "contains",
  "matches",
  "isString",
  "isNumber",
  "jsonSchema",
  "jsonpath",
]);
export type AssertionOp = z.infer<typeof assertionOpSchema>;

/** A declarative assertion: `path` addresses part of the response, `op` compares it. */
export const declarativeAssertionSchema = z.object({
  path: z.string(),
  op: assertionOpSchema,
  value: z.unknown().optional(),
  message: z.string().optional(),
});
export type DeclarativeAssertion = z.infer<typeof declarativeAssertionSchema>;

/** The normalized escape hatch: a real `fn` predicate reduced to a content hash. */
export const fnAssertionSchema = z.object({
  fnHash: z.string(),
  message: z.string().optional(),
});
export type FnAssertion = z.infer<typeof fnAssertionSchema>;

export const assertionSchema = z.union([declarativeAssertionSchema, fnAssertionSchema]);
export type Assertion = z.infer<typeof assertionSchema>;

export const extractorSchema = z.object({
  as: z.string(),
  from: z.string(),
});
export type Extractor = z.infer<typeof extractorSchema>;

export const retryOnSchema = z.enum(["network", "4xx", "5xx", "assertion"]);
export type RetryOn = z.infer<typeof retryOnSchema>;

export const retryPolicySchema = z.object({
  max: z.number().int().nonnegative(),
  backoffMs: z.number().int().nonnegative().default(0),
  on: z.array(retryOnSchema).default([]),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

/** Poll the assertion set until it passes (eventual consistency). */
export const pollPolicySchema = z.object({
  untilAssertPasses: z.literal(true),
  intervalMs: z.number().int().positive(),
  maxMs: z.number().int().positive(),
});
export type PollPolicy = z.infer<typeof pollPolicySchema>;

/**
 * A step is also a DAG node: `needs` is empty for a standalone test's sequential
 * steps and carries edges once a suite normalizes into nodes (see suite.ts).
 */
export const stepSchema = z.object({
  id: z.string(),
  request: requestSchema,
  assert: z.array(assertionSchema).default([]),
  extract: z.array(extractorSchema).default([]),
  retry: retryPolicySchema.optional(),
  poll: pollPolicySchema.optional(),
  needs: z.array(z.string()).default([]),
  timeoutMs: z.number().int().positive().optional(),
});
export type Step = z.infer<typeof stepSchema>;

/** Cartesian matrix: each named dimension expands into discrete executable cells. */
export const matrixSchema = z.record(z.string(), z.array(z.unknown()).min(1));
export type Matrix = z.infer<typeof matrixSchema>;

export const testCaseSchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  title: z.string().optional(),
  tags: z.array(z.string()).default([]),
  owner: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  env: z.record(z.string(), z.unknown()).optional(),
  matrix: matrixSchema.optional(),
  steps: z.array(stepSchema).min(1).refine(uniqueById, "step ids must be unique"),
});
export type TestCase = z.infer<typeof testCaseSchema>;

// ---------------------------------------------------------------------------
// Authored forms (function-carrying; not serializable — kept distinct from the
// normalized schemas above). The engine consumes these and emits normalized IR.
// ---------------------------------------------------------------------------

/** A `params` schema is authored as a builder so tests get a typed Zod object. */
export type ParamsBuilder = (zod: typeof z) => z.ZodType;

/** An authored fn assertion carries the real predicate, later hashed to `fnHash`. */
export interface AuthoredFnAssertion {
  fn: (response: unknown) => boolean;
  message?: string;
}

export type AuthoredAssertion = DeclarativeAssertion | AuthoredFnAssertion;

export interface AuthoredStep {
  id: string;
  request: RequestSpec;
  assert?: AuthoredAssertion[];
  extract?: Extractor[];
  retry?: RetryPolicy;
  poll?: PollPolicy;
  needs?: string[];
  timeoutMs?: number;
}

export interface AuthoredTestCase {
  id: string;
  version: number;
  title?: string;
  tags?: string[];
  owner?: string;
  timeoutMs?: number;
  env?: Record<string, unknown>;
  params?: ParamsBuilder;
  matrix?: Record<string, unknown[]>;
  /** Force Task augmentation (P8). If omitted, the normalizer infers from timeoutMs. */
  isLongRunning?: boolean;
  steps: AuthoredStep[];
}
