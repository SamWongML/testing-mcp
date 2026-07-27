import { randomUUID } from "node:crypto";

import type {
  AssertionResult,
  AuthProviderSpec,
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
import type { EngineResponse, ResolvedRequest, RunContext } from "./context";
import { extract } from "./extract";
import { sendRequest } from "./http";
import { resolveEnv } from "./matrix";
import { resolveParams } from "./params";
import { type PollAttempt, withPoll } from "./poll";
import { redactRequest, redactResponse } from "./redact";
import { type Attempt, withRetry } from "./retry";
import { type PlanNode, planSuite } from "./suite";
import { createRunContext, resolveTemplates } from "./variables";

/**
 * Execution. A test is a one-node-at-a-time run over its steps;
 * a suite (`runSuite`) is a topologically-scheduled DAG over the same node runner,
 * with independent branches running under a bounded concurrency limit. Each node:
 * resolve templates → apply auth → send → assert → extract → publish, with per-step
 * retry, eventual-consistency polling, and redacted snapshots. `attemptStep`/`runStep`
 * are shared by both drivers.
 *
 * Matrix *expansion* stays plan-time (`expandUnits` in `matrix.ts`); the runner executes
 * a single cell — `opts.matrix` populates `{{matrix.*}}` and selects the per-cell env.
 */

/** A single k/n progress tick emitted as a node/step settles. */
export interface ProgressUpdate {
  /** Settled nodes so far (1-based; reaches `total` when the run finishes). */
  completed: number;
  /** Total nodes/steps in the plan. */
  total: number;
  /** The id of the node/step that just settled. */
  nodeId: string;
}

/**
 * Seed state for a resumed attempt: nodes/steps a prior attempt of this **same `runId`**
 * already executed and durably recorded. A seeded node is not re-sent and not re-asserted;
 * its `extracted` bag is rehydrated so downstream templates resolve exactly as if this
 * attempt had run it.
 *
 * The safety property is the caller's to uphold: never seed a node you cannot prove already
 * executed. The engine enforces the other half — {@link RunOptionsBase.onNodeSettled} is
 * awaited before any dependent starts, so "recorded" always implies "definitely ran".
 */
export interface ResumeState {
  /** Terminal results by node/step id — `passed`, `failed`, or `errored`. Never `skipped`
   * or `cancelled`: those are recomputed from their dependencies on every attempt. */
  completed: Record<string, StepResult>;
  /** 1-based count of attempts for this run so far, including this one. */
  runAttempt?: number;
  /** ISO timestamp of the first attempt's start, for end-to-end elapsed time. */
  firstStartedAt?: string;
}

/** Options common to both drivers (single test and suite). */
export interface RunOptionsBase {
  env?: Record<string, unknown>;
  secrets?: Record<string, string>;
  /** Auth provider declarations a step's `request.authRef` may select. Carried by the
   * manifest entry, so a driver forwards `entry.auth` rather than constructing providers. */
  auth?: AuthProviderSpec[];
  /** Matrix-cell coordinates for this run — populates the `{{matrix.*}}` scope and, when
   * `env` isn't passed explicitly, is fed to a matrix-derived `env` builder.
   * Use `expandUnits` to enumerate a matrixed definition's cells. */
  matrix?: Record<string, unknown>;
  signal?: AbortSignal;
  /** Fired as each node/step settles (passed, failed, skipped, or cancelled) so a driver
   * can surface k/n progress; the worker persists it as the run's progress percentage.
   * `completed` counts settled nodes, `total` the plan size. Best-effort and unawaited —
   * a driver that needs a *durable* per-node hook wants `onNodeSettled` instead. */
  onProgress?: (update: ProgressUpdate) => void;
  /** Seed from a prior attempt of this run — see {@link ResumeState}. Absent ⇒ a normal
   * first attempt, which is every caller that doesn't opt in. */
  resumeFrom?: ResumeState;
  /**
   * Fired once a node/step **this attempt actually executed** reaches a terminal,
   * non-cancelled status, and **awaited before any dependent is started**. That ordering is
   * the whole durability boundary: a caller wiring this to a checkpoint write may then trust
   * "recorded ⇒ definitely ran" on a later attempt. Anything looser re-opens the race.
   *
   * Unlike `onProgress`, a rejection is not swallowed — it aborts the run (remaining nodes
   * cancel) and reports `errored`, rather than silently continuing without the safety net.
   */
  onNodeSettled?: (result: StepResult) => Promise<void> | void;
  runId?: string;
  /** The executable-unit id recorded as the result's `entryId` (defaults to the
   * test/suite id). For a matrix cell, pass the cell-addressed id, e.g.
   * `identity.login.matrix#region=us,tier=free`. */
  entryId?: string;
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
    // Resolve templates, then inject auth (seam) — a provider may fetch
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
    return { result: erroredStep(step.id, errorMessage(err)), retryOn: [] };
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
      result: { ...erroredStep(step.id, errorMessage(err)), request: redactedRequest },
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
    entryId: opts.entryId ?? test.id,
    kind: "test" as const,
    env: opts.envName,
    manifestHash: opts.manifestHash,
    gitSha: opts.gitSha,
    runAttempt: opts.resumeFrom?.runAttempt,
    firstStartedAt: opts.resumeFrom?.firstStartedAt,
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

  // A matrix run populates `{{matrix.*}}`; env may be a per-cell builder, so when
  // the caller doesn't pass a resolved `env` we call the authored builder with the coords.
  const matrix = opts.matrix ?? {};
  const ctx = createRunContext({
    env: opts.env ?? resolveEnv(test.env, matrix) ?? {},
    params,
    secrets: opts.secrets ?? {},
    matrix,
    auth: buildAuthRegistry(opts.auth),
    signal: opts.signal,
  });
  const secretValues = collectSecretValues(opts.secrets);

  const steps: StepResult[] = [];
  const total = test.steps.length;
  // Fire onProgress after each step settles — `completed` tracks the pushed count so a
  // driver sees k/n advance (including the skip/cancel fill) up to `total`.
  const settle = (result: StepResult): void => {
    steps.push(result);
    opts.onProgress?.({ completed: steps.length, total, nodeId: result.id });
  };
  let checkpointError: Error | undefined;
  for (let i = 0; i < test.steps.length; i++) {
    const step = test.steps[i] as AuthoredStep;
    // A step a prior attempt already executed is seeded, not re-sent: rehydrate what it
    // published so later steps' `{{nodes.X.var}}`/`{{vars.*}}` resolve, then settle it.
    const seed = opts.resumeFrom?.completed[step.id];
    if (seed) {
      ctx.nodes[step.id] = { ...(ctx.nodes[step.id] ?? {}), ...seed.extracted };
      Object.assign(ctx.vars, seed.extracted);
      settle({ ...seed, resumed: true });
      if (seed.status === "failed" || seed.status === "errored") {
        for (let j = i + 1; j < test.steps.length; j++)
          settle(notRunStep((test.steps[j] as AuthoredStep).id, "skipped"));
        break;
      }
      continue;
    }
    if (ctx.signal?.aborted) {
      settle(notRunStep(step.id, "cancelled"));
      continue;
    }
    const result = await runStep(step, ctx, secretValues, test.timeoutMs);
    // Durability boundary: record this step before the next one can act on what it
    // published (see `onNodeSettled`). A rejection ends the run rather than continuing
    // unrecorded, which would let a later attempt re-send a step that already ran.
    if (result.status !== "cancelled") {
      try {
        await opts.onNodeSettled?.(result);
      } catch (err) {
        checkpointError = err instanceof Error ? err : new Error(String(err));
      }
    }
    settle(result);
    if (checkpointError) {
      for (let j = i + 1; j < test.steps.length; j++)
        settle(notRunStep((test.steps[j] as AuthoredStep).id, "cancelled"));
      break;
    }
    if (result.status === "cancelled") {
      for (let j = i + 1; j < test.steps.length; j++)
        settle(notRunStep((test.steps[j] as AuthoredStep).id, "cancelled"));
      break;
    }
    if (result.status === "failed" || result.status === "errored") {
      // Later steps depend on this one's published vars — skip rather than cascade.
      for (let j = i + 1; j < test.steps.length; j++)
        settle(notRunStep((test.steps[j] as AuthoredStep).id, "skipped"));
      break;
    }
  }

  return finalize({
    ...base,
    status: checkpointError ? "errored" : computeStatus(steps),
    steps,
    params,
    error: checkpointError ? `checkpoint write failed: ${checkpointError.message}` : undefined,
    startedAt,
  });
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
  runAttempt?: number;
  firstStartedAt?: string;
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
    runAttempt: input.runAttempt,
    // Attempt 1 is its own first attempt; only a resumed run carries a distinct value.
    firstStartedAt: input.firstStartedAt ?? input.startedAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Suite execution — DAG scheduling over the shared node runner.
// ---------------------------------------------------------------------------

export interface RunSuiteOptions extends RunOptionsBase {
  /** Max nodes executing at once; independent branches run in parallel up to this.
   * Non-positive or invalid values fall back to the default (never 0, which would hang). */
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
interface ScheduleOutcome {
  results: Map<string, StepResult>;
  /** Set when `onNodeSettled` rejected: the DAG walk lost its durability guarantee partway
   * through, so the caller reports the run as errored rather than trusting the result. */
  checkpointError?: Error;
}

function scheduleNodes(
  plan: PlanNode[],
  baseCtx: RunContext,
  secretValues: string[],
  concurrency: number,
  onProgress?: (update: ProgressUpdate) => void,
  resumeFrom?: ResumeState,
  onNodeSettled?: (result: StepResult) => Promise<void> | void,
  abortForCheckpointFailure?: () => void,
): Promise<ScheduleOutcome> {
  const results = new Map<string, StepResult>();
  // Started but maybe not settled — a node in flight must not look "settled" to its
  // dependents, so readiness keys off `results` while `started` guards against relaunch.
  const started = new Set<string>();
  let checkpointError: Error | undefined;

  // Record a node's terminal result and emit a k/n progress tick — every settle
  // site (ran, seeded, skipped, cancelled) goes through here so `completed` reaches `total`.
  const settle = (nodeId: string, result: StepResult): void => {
    results.set(nodeId, result);
    onProgress?.({ completed: results.size, total: plan.length, nodeId });
  };

  // Seed the frontier before scheduling anything. In *plan* order, not the seed map's key
  // order: `vars` is last-writer-wins, so replaying execution order is what makes a resumed
  // run's flat bag agree with what a from-scratch run would have produced.
  for (const node of plan) {
    const seed = resumeFrom?.completed[node.id];
    if (!seed) continue;
    baseCtx.nodes[node.id] = { ...(baseCtx.nodes[node.id] ?? {}), ...seed.extracted };
    Object.assign(baseCtx.vars, seed.extracted);
    started.add(node.id);
    // Already durably recorded by the attempt that ran it — no `onNodeSettled` here.
    settle(node.id, { ...seed, resumed: true });
  }

  const depsSettled = (node: PlanNode): boolean => node.needs.every((d) => results.has(d));
  const depsPassed = (node: PlanNode): boolean =>
    node.needs.every((d) => results.get(d)?.status === "passed");

  return new Promise((resolve) => {
    let active = 0;

    const pump = (): void => {
      for (const node of plan) {
        if (started.has(node.id) || !depsSettled(node)) continue;
        // Aborting (caller cancel, run-timeout, or a failed checkpoint) short-circuits
        // every remaining node.
        if (baseCtx.signal?.aborted) {
          started.add(node.id);
          settle(node.id, notRunStep(node.id, "cancelled"));
          continue;
        }
        if (!depsPassed(node)) {
          started.add(node.id);
          settle(node.id, notRunStep(node.id, "skipped"));
          continue;
        }
        if (active >= concurrency) continue;
        started.add(node.id);
        active++;
        const nodeCtx: RunContext = { ...baseCtx, params: node.params };
        const finish = async (result: StepResult): Promise<void> => {
          // The durability boundary. `settle` is what makes this node visible to its
          // dependents (and `results.set` is synchronous), so the checkpoint write must be
          // awaited *first* — otherwise a sibling's pump could dispatch this node's
          // dependent while this node is still unrecorded, which is exactly the race a
          // later attempt would resolve by re-sending a request that already went out.
          if (result.status !== "cancelled" && !checkpointError) {
            try {
              await onNodeSettled?.(result);
            } catch (err) {
              checkpointError = err instanceof Error ? err : new Error(String(err));
              abortForCheckpointFailure?.();
            }
          }
          settle(node.id, result);
          active--;
          pump();
        };
        // `runStep` catches its own failures, but guard against a future throw slipping
        // through — an unsettled node here would hang the run and desync `active`.
        void runStep(node.step, nodeCtx, secretValues).then(finish, (err) =>
          finish(erroredStep(node.id, errorMessage(err))),
        );
      }
      if (active === 0 && results.size === plan.length) resolve({ results, checkpointError });
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
    entryId: opts.entryId ?? suite.id,
    kind: "suite" as const,
    env: opts.envName,
    manifestHash: opts.manifestHash,
    gitSha: opts.gitSha,
    runAttempt: opts.resumeFrom?.runAttempt,
    firstStartedAt: opts.resumeFrom?.firstStartedAt,
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
  // A failed checkpoint write is fatal for the run: this controller lets the scheduler
  // short-circuit every not-yet-started node through the same abort cascade a timeout or a
  // caller cancel already uses.
  const checkpointAbort = new AbortController();
  signals.push(checkpointAbort.signal);
  const signal = AbortSignal.any(signals);

  const matrix = opts.matrix ?? {};
  const baseCtx = createRunContext({
    env: opts.env ?? resolveEnv(suite.env, matrix) ?? {},
    secrets: opts.secrets ?? {},
    matrix,
    auth: buildAuthRegistry(opts.auth),
    signal,
  });
  const secretValues = collectSecretValues(opts.secrets);

  // `?? DEFAULT` doesn't guard 0 (a valid number): a 0 limit launches nothing and hangs.
  const concurrency =
    opts.concurrency && opts.concurrency > 0 ? Math.floor(opts.concurrency) : DEFAULT_CONCURRENCY;
  const { results: resultMap, checkpointError } = await scheduleNodes(
    plan,
    baseCtx,
    secretValues,
    concurrency,
    opts.onProgress,
    opts.resumeFrom,
    opts.onNodeSettled,
    () => checkpointAbort.abort(),
  );
  const steps = plan.map((n) => resultMap.get(n.id) as StepResult);

  const timedOut = timeoutSignal?.aborted === true && opts.signal?.aborted !== true;
  return finalize({
    ...base,
    status: checkpointError ? "errored" : timedOut ? "errored" : computeStatus(steps),
    steps,
    error: checkpointError
      ? `checkpoint write failed: ${checkpointError.message}`
      : timedOut
        ? `suite "${suite.id}" exceeded timeoutMs (${suite.timeoutMs}ms)`
        : undefined,
    startedAt,
  });
}
