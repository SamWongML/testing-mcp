import { randomUUID } from "node:crypto";

import type {
  AssertionResult,
  AuthoredStep,
  AuthoredSuite,
  AuthoredTestCase,
  ExecutionResult,
  ExecutionStatus,
  RetryOn,
  RunMetrics,
  StepResult,
} from "@atp/schema";
import { executionResultSchema } from "@atp/schema";

import { evaluateAssertions } from "./assertions";
import { applyAuth, buildAuthRegistry } from "./auth";
import type { AuthProvider, EngineResponse, ResolvedRequest, RunContext } from "./context";
import { extract } from "./extract";
import { sendRequest } from "./http";
import { resolveParams } from "./params";
import { type PollAttempt, withPoll } from "./poll";
import { redactRequest, redactResponse } from "./redact";
import { type Attempt, withRetry } from "./retry";
import { type PlanNode, planSuite } from "./suite";
import { createRunContext, resolveTemplates } from "./variables";

/**
 * Execution (research §10.3). A test is a one-node-at-a-time run over its steps;
 * a suite (`runSuite`) is a topologically-scheduled DAG over the same node runner,
 * with independent branches running under a bounded concurrency limit. Each node:
 * resolve templates → apply auth → send → assert → extract → publish, with per-step
 * retry, eventual-consistency polling, and redacted snapshots. `attemptStep`/`runStep`
 * are shared by both drivers.
 *
 * Matrix expansion is still out of scope here (P3).
 */

/** Options common to both drivers (single test and suite). */
export interface RunOptionsBase {
  env?: Record<string, unknown>;
  secrets?: Record<string, string>;
  /** Auth providers a step's `request.authRef` may select (research §10.3). */
  auth?: AuthProvider[];
  signal?: AbortSignal;
  runId?: string;
  /** Env name recorded on the result (the resolved env values come from `env`). */
  envName?: string;
  manifestHash?: string;
  gitSha?: string;
}

export interface RunTestOptions extends RunOptionsBase {
  params?: Record<string, unknown>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Non-empty secret values, for redaction — an empty string would over-redact. */
function collectSecretValues(secrets: Record<string, string> | undefined): string[] {
  return Object.values(secrets ?? {}).filter((v) => v.length > 0);
}

function erroredStep(id: string, message: string): StepResult {
  return { id, status: "errored", assertions: [], extracted: {}, attempts: 1, error: message };
}

function notRunStep(id: string, status: "cancelled" | "skipped"): StepResult {
  return { id, status, assertions: [], extracted: {}, attempts: 0 };
}

async function attemptStep(
  step: AuthoredStep,
  ctx: RunContext,
  secretValues: string[],
  fallbackTimeoutMs?: number,
): Promise<Attempt<StepResult>> {
  let request: ResolvedRequest;
  try {
    // Resolve templates, then inject auth (research §10.3 seam) — a provider may fetch
    // a token, so this can await and can be aborted by cancellation.
    request = await applyAuth(resolveTemplates(step.request, ctx), ctx);
  } catch (err) {
    // Cancellation during an auth token fetch reads as cancelled, not a run error.
    if (ctx.signal?.aborted) {
      return {
        result: { id: step.id, status: "cancelled", assertions: [], extracted: {}, attempts: 1 },
        retryOn: [],
      };
    }
    // An unresolved template or unknown authRef is an authoring/config error, not transient.
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
  const timeoutMs = step.timeoutMs ?? fallbackTimeoutMs;
  const asserts = step.assert ?? [];

  // One send + assertion pass — the unit `withPoll` repeats for eventual consistency.
  const sendAndAssert = async (): Promise<
    PollAttempt<{ response: EngineResponse; assertions: AssertionResult[] }>
  > => {
    const response = await sendRequest(request, { signal: ctx.signal, timeoutMs });
    const assertions = evaluateAssertions(asserts, response);
    return { result: { response, assertions }, ok: assertions.every((a) => a.ok) };
  };

  let response: EngineResponse;
  let assertions: AssertionResult[];
  try {
    const settled = step.poll?.untilAssertPasses
      ? await withPoll(step.poll, sendAndAssert, { signal: ctx.signal })
      : (await sendAndAssert()).result;
    ({ response, assertions } = settled);
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

  const extracted = extract(step.extract ?? [], response);
  ctx.nodes[step.id] = { ...(ctx.nodes[step.id] ?? {}), ...extracted };
  Object.assign(ctx.vars, extracted);

  const assertionsOk = assertions.every((a) => a.ok);
  const retryOn: RetryOn[] = [];
  if (response.status >= 500) retryOn.push("5xx");
  else if (response.status >= 400) retryOn.push("4xx");
  // `poll` already spent the assertion-retry budget, so don't also hand `assertion`
  // to `withRetry` — that would restart the whole poll loop per transport attempt.
  if (!assertionsOk && !step.poll?.untilAssertPasses) retryOn.push("assertion");

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
  ctx: RunContext,
  secretValues: string[],
  fallbackTimeoutMs?: number,
): Promise<StepResult> {
  const { result, attempts } = await withRetry(
    step.retry,
    () => attemptStep(step, ctx, secretValues, fallbackTimeoutMs),
    { signal: ctx.signal },
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
    auth: buildAuthRegistry(opts.auth),
    signal: opts.signal,
  });
  const secretValues = collectSecretValues(opts.secrets);

  const steps: StepResult[] = [];
  for (let i = 0; i < test.steps.length; i++) {
    const step = test.steps[i] as AuthoredStep;
    if (ctx.signal?.aborted) {
      steps.push(notRunStep(step.id, "cancelled"));
      continue;
    }
    const result = await runStep(step, ctx, secretValues, test.timeoutMs);
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
  kind: "test" | "suite";
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

// ---------------------------------------------------------------------------
// Suite execution — DAG scheduling over the shared node runner (research §12).
// ---------------------------------------------------------------------------

export interface RunSuiteOptions extends RunOptionsBase {
  /** Max nodes executing at once; independent branches run in parallel up to this.
   *  Non-positive or invalid values fall back to the default (never 0, which would hang). */
  concurrency?: number;
}

const DEFAULT_CONCURRENCY = 8;

/**
 * Schedule an ordered plan as a DAG: a node runs once all its `needs` have settled and
 * passed, with up to `concurrency` nodes in flight. A node whose dependency did not pass
 * is `skipped`; once `signal` aborts, every not-yet-started node is `cancelled`. Each
 * node gets its own `params` scope while sharing the suite-wide `nodes`/`vars` bags, so
 * `{{nodes.X.var}}` resolves across branches — that namespaced form is the deterministic
 * cross-node addressing. (The flat `{{vars.*}}` bag is last-writer-wins across parallel
 * branches, so it is only reliable within a single dependency chain.) Returns results
 * keyed by node id.
 */
function scheduleNodes(
  plan: PlanNode[],
  baseCtx: RunContext,
  secretValues: string[],
  concurrency: number,
): Promise<Map<string, StepResult>> {
  const results = new Map<string, StepResult>();
  // Started but maybe not settled — a node in flight must not look "settled" to its
  // dependents, so readiness keys off `results` while `started` guards against relaunch.
  const started = new Set<string>();

  const depsSettled = (node: PlanNode): boolean => node.needs.every((d) => results.has(d));
  const depsPassed = (node: PlanNode): boolean =>
    node.needs.every((d) => results.get(d)?.status === "passed");

  return new Promise((resolve) => {
    let active = 0;

    const pump = (): void => {
      for (const node of plan) {
        if (started.has(node.id) || !depsSettled(node)) continue;
        // Aborting (caller cancel or run-timeout) short-circuits every remaining node.
        if (baseCtx.signal?.aborted) {
          started.add(node.id);
          results.set(node.id, notRunStep(node.id, "cancelled"));
          continue;
        }
        if (!depsPassed(node)) {
          started.add(node.id);
          results.set(node.id, notRunStep(node.id, "skipped"));
          continue;
        }
        if (active >= concurrency) continue;
        started.add(node.id);
        active++;
        const nodeCtx: RunContext = { ...baseCtx, params: node.params };
        const finish = (result: StepResult): void => {
          results.set(node.id, result);
          active--;
          pump();
        };
        // `runStep` catches its own failures, but guard against a future throw slipping
        // through — an unsettled node here would hang the run and desync `active`.
        void runStep(node.step, nodeCtx, secretValues).then(finish, (err) =>
          finish(erroredStep(node.id, errorMessage(err))),
        );
      }
      if (active === 0 && results.size === plan.length) resolve(results);
    };

    pump();
  });
}

/** Run an authored suite as a DAG and return a validated `ExecutionResult`. */
export async function runSuite(
  suite: AuthoredSuite,
  opts: RunSuiteOptions = {},
): Promise<ExecutionResult> {
  const runId = opts.runId ?? randomUUID();
  const startedAt = new Date();
  const base = {
    runId,
    entryId: suite.id,
    kind: "suite" as const,
    env: opts.envName,
    manifestHash: opts.manifestHash,
    gitSha: opts.gitSha,
  };

  let plan: PlanNode[];
  try {
    plan = planSuite(suite);
  } catch (err) {
    // Structural errors (cycles, unknown/duplicate ids) surface as an errored run,
    // mirroring how the single-test runner reports invalid params rather than throwing.
    return finalize({ ...base, status: "errored", steps: [], error: errorMessage(err), startedAt });
  }

  // A suite-level `timeoutMs` is a whole-run budget: an abort signal combined with the
  // caller's cancel signal. When it alone fires the run is `errored` (timed out); when
  // the caller aborts the run is `cancelled` (computed from the cancelled nodes).
  const signals: AbortSignal[] = [];
  if (opts.signal) signals.push(opts.signal);
  let timeoutSignal: AbortSignal | undefined;
  if (suite.timeoutMs) {
    timeoutSignal = AbortSignal.timeout(suite.timeoutMs);
    signals.push(timeoutSignal);
  }
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;

  const baseCtx = createRunContext({
    env: opts.env ?? suite.env ?? {},
    secrets: opts.secrets ?? {},
    auth: buildAuthRegistry(opts.auth),
    signal,
  });
  const secretValues = collectSecretValues(opts.secrets);

  // `?? DEFAULT` doesn't guard 0 (a valid number): a 0 limit launches nothing and hangs.
  const concurrency =
    opts.concurrency && opts.concurrency > 0 ? Math.floor(opts.concurrency) : DEFAULT_CONCURRENCY;
  const resultMap = await scheduleNodes(plan, baseCtx, secretValues, concurrency);
  const steps = plan.map((n) => resultMap.get(n.id) as StepResult);

  const timedOut = timeoutSignal?.aborted === true && opts.signal?.aborted !== true;
  return finalize({
    ...base,
    status: timedOut ? "errored" : computeStatus(steps),
    steps,
    error: timedOut ? `suite "${suite.id}" exceeded timeoutMs (${suite.timeoutMs}ms)` : undefined,
    startedAt,
  });
}
