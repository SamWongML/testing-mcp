import { randomUUID } from "node:crypto";

import type {
  AuthoredStep,
  AuthoredTestCase,
  ExecutionResult,
  ExecutionStatus,
  RetryOn,
  RunMetrics,
  StepResult,
} from "@atp/schema";
import { executionResultSchema } from "@atp/schema";
import { z } from "zod";

import { evaluateAssertions } from "./assertions";
import type { EngineResponse, ResolvedRequest, RunContext } from "./context";
import { extract } from "./extract";
import { sendRequest } from "./http";
import { redactRequest, redactResponse } from "./redact";
import { type Attempt, withRetry } from "./retry";
import { createRunContext, resolveTemplates } from "./variables";

/**
 * Single-test execution (research §10.3). A test is a one-node-at-a-time run over
 * its steps: resolve templates → send → assert → extract → publish, with per-step
 * retry and redacted snapshots. The node runner (`attemptStep`) is kept reusable so
 * P3's DAG runner can schedule the same unit across a topologically-sorted graph.
 *
 * `poll`, matrix expansion and real auth providers are out of scope here (P3).
 */

export interface RunTestOptions {
  params?: Record<string, unknown>;
  env?: Record<string, unknown>;
  secrets?: Record<string, string>;
  signal?: AbortSignal;
  runId?: string;
  /** Env name recorded on the result (the resolved env values come from `env`). */
  envName?: string;
  manifestHash?: string;
  gitSha?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function notRunStep(id: string, status: "cancelled" | "skipped"): StepResult {
  return { id, status, assertions: [], extracted: {}, attempts: 0 };
}

function resolveParams(
  test: AuthoredTestCase,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!test.params) return { ...(input ?? {}) };
  return test.params(z).parse(input ?? {}) as Record<string, unknown>;
}

async function attemptStep(
  step: AuthoredStep,
  test: AuthoredTestCase,
  ctx: RunContext,
  secretValues: string[],
): Promise<Attempt<StepResult>> {
  let request: ResolvedRequest;
  try {
    request = resolveTemplates(step.request, ctx);
  } catch (err) {
    // A template that cannot resolve is an authoring/data error, not transient.
    return {
      result: {
        id: step.id,
        status: "errored",
        assertions: [],
        extracted: {},
        attempts: 1,
        error: errorMessage(err),
      },
      retryOn: [],
    };
  }

  const redactedRequest = redactRequest(request, secretValues);
  let response: EngineResponse;
  try {
    response = await sendRequest(request, {
      signal: ctx.signal,
      timeoutMs: step.timeoutMs ?? test.timeoutMs,
    });
  } catch (err) {
    if (ctx.signal?.aborted) {
      return {
        result: {
          id: step.id,
          status: "cancelled",
          request: redactedRequest,
          assertions: [],
          extracted: {},
          attempts: 1,
        },
        retryOn: [],
      };
    }
    return {
      result: {
        id: step.id,
        status: "errored",
        request: redactedRequest,
        assertions: [],
        extracted: {},
        attempts: 1,
        error: errorMessage(err),
      },
      retryOn: ["network"],
    };
  }

  const assertions = evaluateAssertions(step.assert ?? [], response);
  const extracted = extract(step.extract ?? [], response);
  ctx.nodes[step.id] = { ...(ctx.nodes[step.id] ?? {}), ...extracted };
  Object.assign(ctx.vars, extracted);

  const assertionsOk = assertions.every((a) => a.ok);
  const retryOn: RetryOn[] = [];
  if (response.status >= 500) retryOn.push("5xx");
  else if (response.status >= 400) retryOn.push("4xx");
  if (!assertionsOk) retryOn.push("assertion");

  return {
    result: {
      id: step.id,
      status: assertionsOk ? "passed" : "failed",
      request: redactedRequest,
      response: redactResponse(response, secretValues),
      assertions,
      extracted,
      timingMs: response.timingMs,
      attempts: 1,
    },
    retryOn,
  };
}

async function runStep(
  step: AuthoredStep,
  test: AuthoredTestCase,
  ctx: RunContext,
  secretValues: string[],
): Promise<StepResult> {
  const { result, attempts } = await withRetry(
    step.retry,
    (_attempt) => attemptStep(step, test, ctx, secretValues),
    {
      signal: ctx.signal,
    },
  );
  return { ...result, attempts };
}

function computeStatus(steps: StepResult[]): ExecutionStatus {
  if (steps.some((s) => s.status === "cancelled")) return "cancelled";
  if (steps.some((s) => s.status === "errored")) return "errored";
  if (steps.some((s) => s.status === "failed")) return "failed";
  return "passed";
}

function computeMetrics(steps: StepResult[]): RunMetrics {
  return {
    totalSteps: steps.length,
    passedSteps: steps.filter((s) => s.status === "passed").length,
    failedSteps: steps.filter((s) => s.status === "failed" || s.status === "errored").length,
    totalAssertions: steps.reduce((n, s) => n + s.assertions.length, 0),
    failedAssertions: steps.reduce((n, s) => n + s.assertions.filter((a) => !a.ok).length, 0),
  };
}

/** Run a single authored test end-to-end and return a validated `ExecutionResult`. */
export async function runTest(
  test: AuthoredTestCase,
  opts: RunTestOptions = {},
): Promise<ExecutionResult> {
  const runId = opts.runId ?? randomUUID();
  const startedAt = new Date();

  const base = {
    runId,
    entryId: test.id,
    kind: "test" as const,
    env: opts.envName,
    manifestHash: opts.manifestHash,
    gitSha: opts.gitSha,
  };

  let params: Record<string, unknown>;
  try {
    params = resolveParams(test, opts.params);
  } catch (err) {
    return finalize({
      ...base,
      status: "errored",
      steps: [],
      params: opts.params,
      error: `invalid params: ${errorMessage(err)}`,
      startedAt,
    });
  }

  const ctx = createRunContext({
    env: opts.env ?? test.env ?? {},
    params,
    secrets: opts.secrets ?? {},
    signal: opts.signal,
  });
  const secretValues = Object.values(opts.secrets ?? {}).filter((v) => v.length > 0);

  const steps: StepResult[] = [];
  for (let i = 0; i < test.steps.length; i++) {
    const step = test.steps[i] as AuthoredStep;
    if (ctx.signal?.aborted) {
      steps.push(notRunStep(step.id, "cancelled"));
      continue;
    }
    const result = await runStep(step, test, ctx, secretValues);
    steps.push(result);
    if (result.status === "cancelled") {
      for (let j = i + 1; j < test.steps.length; j++)
        steps.push(notRunStep((test.steps[j] as AuthoredStep).id, "cancelled"));
      break;
    }
    if (result.status === "failed" || result.status === "errored") {
      // Later steps depend on this one's published vars — skip rather than cascade.
      for (let j = i + 1; j < test.steps.length; j++)
        steps.push(notRunStep((test.steps[j] as AuthoredStep).id, "skipped"));
      break;
    }
  }

  return finalize({ ...base, status: computeStatus(steps), steps, params, startedAt });
}

function finalize(input: {
  runId: string;
  entryId: string;
  kind: "test";
  status: ExecutionStatus;
  steps: StepResult[];
  params?: Record<string, unknown>;
  env?: string;
  error?: string;
  manifestHash?: string;
  gitSha?: string;
  startedAt: Date;
}): ExecutionResult {
  const finishedAt = new Date();
  return executionResultSchema.parse({
    runId: input.runId,
    entryId: input.entryId,
    kind: input.kind,
    status: input.status,
    params: input.params,
    env: input.env,
    steps: input.steps,
    startedAt: input.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - input.startedAt.getTime(),
    metrics: computeMetrics(input.steps),
    manifestHash: input.manifestHash,
    gitSha: input.gitSha,
    error: input.error,
  });
}
