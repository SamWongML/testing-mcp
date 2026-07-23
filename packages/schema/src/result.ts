import { z } from "zod";

import { assertionOpSchema, requestSchema } from "./test";

/**
 * The single canonical execution result (research §14, ADR-006). One typed value
 * feeds every P5 renderer — markdown, html, junit, trace.json, and `llm_summary` —
 * so the shape must carry: per-step status, redacted request/response snapshots,
 * assertion detail (expected/actual for diagnostics), timings, attempts, and the
 * `manifestHash` + `gitSha` every run records (§21).
 */

/** Terminal statuses for a finished run. In-flight task states live at the MCP layer. */
export const executionStatusSchema = z.enum(["passed", "failed", "cancelled", "errored"]);
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const stepStatusSchema = z.enum(["passed", "failed", "skipped", "cancelled", "errored"]);
export type StepStatus = z.infer<typeof stepStatusSchema>;

export const assertionResultSchema = z.object({
  ok: z.boolean(),
  /** Absent for `fn` (escape-hatch) assertions. */
  op: assertionOpSchema.optional(),
  path: z.string().optional(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  message: z.string().optional(),
});
export type AssertionResult = z.infer<typeof assertionResultSchema>;

/** A redacted response snapshot (secrets removed before persistence — §21). */
export const responseSnapshotSchema = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
  timingMs: z.number().nonnegative().optional(),
});
export type ResponseSnapshot = z.infer<typeof responseSnapshotSchema>;

export const stepResultSchema = z.object({
  id: z.string(),
  status: stepStatusSchema,
  /** Redacted request snapshot (same shape as the request IR). */
  request: requestSchema.optional(),
  response: responseSnapshotSchema.optional(),
  assertions: z.array(assertionResultSchema).default([]),
  extracted: z.record(z.string(), z.unknown()).default({}),
  timingMs: z.number().nonnegative().optional(),
  attempts: z.number().int().positive().default(1),
  /** Populated for `errored`/`failed` steps — feeds the likely-cause heuristic. */
  error: z.string().optional(),
});
export type StepResult = z.infer<typeof stepResultSchema>;

export const runMetricsSchema = z.object({
  totalSteps: z.number().int().nonnegative(),
  passedSteps: z.number().int().nonnegative(),
  failedSteps: z.number().int().nonnegative(),
  totalAssertions: z.number().int().nonnegative().default(0),
  failedAssertions: z.number().int().nonnegative().default(0),
});
export type RunMetrics = z.infer<typeof runMetricsSchema>;

export const executionResultSchema = z.object({
  runId: z.string(),
  entryId: z.string(),
  kind: z.enum(["test", "suite"]).optional(),
  status: executionStatusSchema,
  params: z.record(z.string(), z.unknown()).optional(),
  env: z.string().optional(),
  steps: z.array(stepResultSchema).default([]),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().optional(),
  durationMs: z.number().nonnegative().optional(),
  metrics: runMetricsSchema,
  /** Reproducibility: every run records the manifest + commit it ran against (§21). */
  manifestHash: z.string().optional(),
  gitSha: z.string().optional(),
  /** Run-level error (e.g. timeout, cancellation reason). */
  error: z.string().optional(),
});
export type ExecutionResult = z.infer<typeof executionResultSchema>;
