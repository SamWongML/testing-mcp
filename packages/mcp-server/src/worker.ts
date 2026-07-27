import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import type { Config, ManifestEntry } from "@atp/schema";
import type { ExecutionResult } from "@atp/schema";
import {
  claim,
  getCheckpoints,
  heartbeat,
  isCancelRequested,
  type Job,
  markDone,
  pruneCheckpoints,
  putCheckpoint,
  queueDepth,
  reapExpired,
  sweepExpiredCheckpoints,
  sweepTerminalJobs,
  type Db,
  type TaskState,
} from "@atp/store";

import type { ServerContext } from "./context";
import { executeEntry } from "./execute";
import { parseSpec, requireDb as ensureDb, resultStateFor, taskStoreFor } from "./tasks";
import { persistRun } from "./run-store";
import { extractTraceContext, withSpan } from "./telemetry";

/**
 * The async worker. It claims queued jobs with
 * `FOR UPDATE SKIP LOCKED`, runs the engine under an `AbortSignal`, streams k/n progress
 * into the hot task state, persists artifacts + history, and drives the task to a terminal
 * state — then a reaper requeues jobs whose worker died (lease expiry). No broker: the
 * durability is Postgres. `MODE=worker` (`pnpm dev:worker`) runs {@link startWorker}; the
 * finer-grained functions are the seams the integration tests drive.
 */
export interface WorkerOptions {
  /** Stable id claimed jobs are stamped with (lease ownership). */
  workerId?: string;
  /** How often a running job refreshes its lease and polls the cancel flag. */
  heartbeatMs?: number;
  /** A job whose lease is older than this is considered dead and requeued. */
  leaseMs?: number;
  /** Idle sleep between empty claims. */
  pollMs?: number;
  /** How often the loop runs the reaper. */
  reapMs?: number;
  /** How often the loop sweeps expired task rows (SEP-1686 result retention). */
  sweepMs?: number;
  /** Stop after this many runs. `1` is the one-shot mode an `ecs:RunTask`-launched task uses
   * (mode 2): claim one job, finish it, exit. Unset ⇒ run until stopped. */
  maxRuns?: number;
  /** Claim only this run's job (mode 2). The one-off task was launched for one
   * specific run and must not drain arbitrary queue head. */
  runId?: string;
  /** Stop after this long with nothing claimed. Bounds a one-off task whose run was already
   * taken by a pooled worker, so it exits instead of idling as billable capacity. */
  idleTimeoutMs?: number;
}

/**
 * Map validated config onto {@link WorkerOptions}. This is the *only* thing connecting the
 * environment the `ecs:RunTask` launcher sets (`WORKER_ONCE`, `ATP_RUN_ID`) to the worker
 * loop — without it those variables are decorative and a launched task runs forever.
 */
export function workerOptionsFromConfig(config: Config): WorkerOptions {
  if (!config.WORKER_ONCE) return {};
  return {
    maxRuns: 1,
    runId: config.ATP_RUN_ID,
    idleTimeoutMs: config.WORKER_IDLE_TIMEOUT_MS,
  };
}

const DEFAULTS = {
  heartbeatMs: 1000,
  leaseMs: 30_000,
  pollMs: 500,
  reapMs: 5_000,
  // Result expiry is measured in hours, so sweeping every 5 minutes is ample and keeps the
  // extra query off the hot claim path.
  sweepMs: 300_000,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function findEntry(ctx: ServerContext, entryId: string): ManifestEntry | undefined {
  return ctx.manifest.entries.find((e) => e.id === entryId);
}

const requireDb = (ctx: ServerContext): Db =>
  ensureDb(ctx, "the worker requires a configured run database (set DATABASE_URL)");

/**
 * Execute one already-claimed job end-to-end and return its terminal task state. Runs the
 * engine under a cancellation signal driven by a heartbeat timer that also refreshes the
 * lease; progress ticks are serialized into the task row ahead of the terminal write.
 */
export async function runClaimedJob(
  ctx: ServerContext,
  job: Job,
  workerId: string,
  opts: WorkerOptions = {},
): Promise<TaskStateResult> {
  const db = requireDb(ctx);
  const tasks = taskStoreFor(ctx, db);
  const runId = job.runId ?? job.id;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULTS.heartbeatMs;
  // Correlation ids thread through every line this run emits.
  const log = ctx.logger?.child({ runId, taskId: runId });

  // Cancel-while-queued: a job flagged before it was claimed never runs.
  if (job.cancelRequested) {
    await tasks.update(runId, { state: "cancelled" });
    await markDone(db, job.id, workerId, "done");
    // Defensive: covers checkpoints orphaned by an earlier attempt that was abandoned
    // before this claim.
    await pruneRunCheckpoints(db, runId, log);
    log?.info("run cancelled while queued");
    return { runId, state: "cancelled" };
  }

  let spec;
  try {
    spec = parseSpec(job.spec);
  } catch (err) {
    return finalizeError(ctx, job, workerId, runId, errorMessage(err));
  }
  const entry = findEntry(ctx, spec.entryId);
  if (!entry) {
    return finalizeError(ctx, job, workerId, runId, `unknown entry "${spec.entryId}"`);
  }
  log?.info({ entryId: entry.id, kind: entry.kind }, "claimed run");

  // What a prior attempt of this run already executed. Fail-closed: a read error finalizes
  // the job rather than being treated as "nothing to resume", which would silently re-fire
  // every side effect the earlier attempt already made.
  let checkpoints;
  try {
    checkpoints = await getCheckpoints(db, runId);
  } catch (err) {
    return finalizeError(ctx, job, workerId, runId, `could not load checkpoints: ${errorMessage(err)}`);
  }
  const runAttempt = (job.attempts ?? 0) + 1;
  if (runAttempt > 1) {
    log?.info(
      { runAttempt, resumedNodes: Object.keys(checkpoints).length },
      "resuming run from checkpoints",
    );
  }

  const controller = new AbortController();
  // Serialize progress writes and keep the terminal write strictly after the last one, so a
  // late tick can't clobber progressPct=100.
  let progressChain: Promise<unknown> = Promise.resolve();

  const beat = setInterval(() => {
    void (async () => {
      try {
        await heartbeat(db, job.id, workerId);
        if (await isCancelRequested(db, job.id)) controller.abort();
      } catch {
        // A transient heartbeat/poll error must not crash the worker mid-run; the reaper is
        // the backstop if the lease genuinely lapses.
      }
    })();
  }, heartbeatMs);

  // Wrap execution in a run span (when telemetry is on) so the engine's undici SUT calls nest
  // under it — the MCP-call → run → SUT-call trace.
  const execute = (): Promise<ExecutionResult> =>
    executeEntry(ctx, entry, {
      params: spec.params,
      env: spec.env,
      runId,
      signal: controller.signal,
      onProgress: (u) => {
        const pct = u.total > 0 ? Math.round((u.completed / u.total) * 100) : 0;
        log?.debug({ nodeId: u.nodeId, completed: u.completed, total: u.total }, "node settled");
        // Advisory: a transient progress-write failure must not fail an otherwise-good run,
        // so swallow per-tick errors (the terminal write is the authoritative state).
        progressChain = progressChain.then(() =>
          tasks.setProgress(runId, pct, u.nodeId).catch(() => {}),
        );
      },
      resumeFrom: {
        completed: checkpoints,
        runAttempt,
        firstStartedAt: job.firstClaimedAt?.toISOString(),
      },
      // Deliberately not chained/best-effort like onProgress: the engine awaits this before
      // starting any dependent, and treats a rejection as fatal. That is the contract that
      // lets the next attempt trust "checkpointed ⇒ definitely ran".
      onNodeSettled: (result) => putCheckpoint(db, { runId, nodeId: result.id, payload: result }),
    });

  try {
    const result = ctx.telemetry
      ? await withSpan(ctx.telemetry.tracer, `run ${entry.id}`, execute, {
          attributes: { "atp.run_id": runId, "atp.entry_id": entry.id },
          // Re-parent onto the submitting request's trace — the enqueue→claim hop
          // crosses processes, so the context travels in the job spec.
          parent: extractTraceContext(spec.trace),
        })
      : await execute();
    clearInterval(beat);
    await progressChain;

    const state = resultStateFor(result.status);
    const { traceUri } = await persistRun(ctx, result);
    await tasks.update(runId, {
      state,
      progressPct: 100,
      resultRef: traceUri,
      error: result.error,
    });
    recordRunMetrics(ctx, entry.id, result, state);
    log?.info({ state, durationMs: result.durationMs }, "run terminal");
    // A cancelled/completed job is terminal (never requeue); only a failed run is 'failed'.
    await markDone(db, job.id, workerId, state === "failed" ? "failed" : "done");
    await pruneRunCheckpoints(db, runId, log);
    return { runId, state };
  } catch (err) {
    clearInterval(beat);
    log?.error({ err: errorMessage(err) }, "run threw");
    return finalizeError(ctx, job, workerId, runId, errorMessage(err));
  }
}

export interface TaskStateResult {
  runId: string;
  /** The terminal state the job settled into (completed | failed | cancelled). */
  state: TaskState;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Drop a finished run's checkpoints. Best-effort: a terminal run is never resumed, so
 * leftovers are inert and the TTL sweep collects them anyway — never fail a settled run over
 * its own cleanup. */
async function pruneRunCheckpoints(db: Db, runId: string, log?: ServerContext["logger"]) {
  try {
    await pruneCheckpoints(db, runId);
  } catch (err) {
    log?.warn({ runId, err: errorMessage(err) }, "could not prune run checkpoints");
  }
}

/** Publish the per-run metrics: the terminal-count/duration + one assertion-failure tick
 * per failed assertion, tagged by test for the `assertion_failures_total{test}` breakdown. */
function recordRunMetrics(
  ctx: ServerContext,
  entryId: string,
  result: ExecutionResult,
  state: TaskState,
): void {
  const metrics = ctx.telemetry?.metrics;
  if (!metrics) return;
  metrics.recordRun(state, result.durationMs ?? 0);
  const failed = result.steps.reduce((n, s) => n + s.assertions.filter((a) => !a.ok).length, 0);
  if (failed > 0) metrics.recordAssertionFailure(entryId, failed);
}

/** Terminal-fail a job that could not be executed (bad spec, unknown entry, unexpected throw). */
async function finalizeError(
  ctx: ServerContext,
  job: Job,
  workerId: string,
  runId: string,
  error: string,
): Promise<TaskStateResult> {
  const db = requireDb(ctx);
  await taskStoreFor(ctx, db).update(runId, { state: "failed", error });
  await markDone(db, job.id, workerId, "failed");
  await pruneRunCheckpoints(db, runId, ctx.logger);
  return { runId, state: "failed" };
}

/** Claim one ready job and run it; returns false when the queue was empty. Samples `queue_depth`
 * before claiming so the autoscaling metric reflects the backlog each poll. */
export async function claimAndRun(
  ctx: ServerContext,
  workerId: string,
  opts: WorkerOptions = {},
): Promise<boolean> {
  const db = requireDb(ctx);
  if (ctx.telemetry) ctx.telemetry.metrics.setQueueDepth(await queueDepth(db));
  const job = await claim(db, workerId, { runId: opts.runId });
  if (!job) return false;
  await runClaimedJob(ctx, job, workerId, opts);
  return true;
}

/**
 * Delete task rows past their TTL — the SEP-1686 "results retained for a server-defined
 * duration" GC. It runs in the worker rather than as a separate scheduled job so the
 * deployment stays two processes; on DynamoDB the native TTL reaps in parallel and this is
 * the deterministic sweep alongside it. Returns how many rows were removed.
 */
export async function sweepExpiredTasks(ctx: ServerContext): Promise<number> {
  return taskStoreFor(ctx, requireDb(ctx)).deleteExpired();
}

/**
 * Requeue jobs whose lease expired (crashed workers), and finalize any that exhausted their
 * attempt budget. Returns the number of jobs touched.
 *
 * The dead-letter half is what stops a job that reliably kills its worker from looping
 * forever while its client polls a `working` task that will never settle: the task row is
 * driven to a terminal, reportable state and the run's checkpoints are dropped. A pending
 * cancel wins over "we gave up retrying" — the flag survives the reap, and reporting it as
 * `failed` would misattribute a deliberate stop.
 */
export async function reapOnce(ctx: ServerContext, leaseMs: number): Promise<number> {
  const db = requireDb(ctx);
  const reaped = await reapExpired(db, leaseMs);
  for (const job of reaped) {
    if (job.status !== "dead_letter") continue;
    const runId = job.runId ?? job.id;
    await taskStoreFor(ctx, db).update(runId, {
      state: job.cancelRequested ? "cancelled" : "failed",
      error: job.cancelRequested
        ? undefined
        : (job.lastError ??
          `job exhausted ${job.maxAttempts} attempt(s) — its worker died repeatedly`),
    });
    await pruneRunCheckpoints(db, runId, ctx.logger);
    ctx.logger?.warn(
      { runId, attempts: job.attempts, maxAttempts: job.maxAttempts },
      "job dead-lettered: exhausted its attempt budget",
    );
  }
  return reaped.length;
}

/** TTL backstop for checkpoints orphaned by a process that died before pruning its own. */
export async function sweepExpiredCheckpointsOnce(ctx: ServerContext): Promise<number> {
  return sweepExpiredCheckpoints(requireDb(ctx));
}

/** How long a settled job's row (and its `spec` payload) is kept before the sweep removes
 * it. Long enough to investigate a bad run; the run's history and trace are unaffected. */
export const TERMINAL_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Drop terminal job rows past their retention window. */
export async function sweepTerminalJobsOnce(ctx: ServerContext): Promise<number> {
  return sweepTerminalJobs(requireDb(ctx), TERMINAL_JOB_RETENTION_MS);
}

export interface WorkerHandle {
  workerId: string;
  stop: () => Promise<void>;
  /** Resolves when the loop ends — either via `stop()` or by hitting `maxRuns`. */
  done: Promise<void>;
}

/**
 * Run the claim→execute→reap loop until stopped. The returned handle's `stop()` lets the
 * current in-flight job finish, then resolves — the entrypoint wires it to SIGINT/SIGTERM.
 */
export function startWorker(ctx: ServerContext, opts: WorkerOptions = {}): WorkerHandle {
  requireDb(ctx);
  const workerId = opts.workerId ?? `${hostname()}-${randomUUID().slice(0, 8)}`;
  const leaseMs = opts.leaseMs ?? DEFAULTS.leaseMs;
  const pollMs = opts.pollMs ?? DEFAULTS.pollMs;
  const reapMs = opts.reapMs ?? DEFAULTS.reapMs;
  const sweepMs = opts.sweepMs ?? DEFAULTS.sweepMs;

  let running = true;
  let lastReap = 0;
  let lastSweep = Date.now();
  let completed = 0;
  let idleSince = Date.now();

  const loop = (async () => {
    while (running) {
      try {
        if (Date.now() - lastReap >= reapMs) {
          // Log it: a silent reap loop is how a crashing job stays invisible while it
          // consumes a worker slot every cycle.
          const reaped = await reapOnce(ctx, leaseMs);
          lastReap = Date.now();
          if (reaped > 0) ctx.logger?.warn({ reaped }, "reaped jobs with expired leases");
        }
        if (Date.now() - lastSweep >= sweepMs) {
          const swept = await sweepExpiredTasks(ctx);
          const sweptCheckpoints = await sweepExpiredCheckpointsOnce(ctx).catch(() => 0);
          const sweptJobs = await sweepTerminalJobsOnce(ctx).catch(() => 0);
          lastSweep = Date.now();
          if (swept > 0 || sweptCheckpoints > 0 || sweptJobs > 0) {
            ctx.logger?.debug({ swept, sweptCheckpoints, sweptJobs }, "swept expired rows");
          }
        }
        const ran = await claimAndRun(ctx, workerId, opts);
        if (ran) {
          idleSince = Date.now();
          if (opts.maxRuns !== undefined && ++completed >= opts.maxRuns) running = false;
        } else if (
          opts.idleTimeoutMs !== undefined &&
          Date.now() - idleSince >= opts.idleTimeoutMs
        ) {
          // Nothing left to do (typically: the pool claimed this run first). Exiting frees
          // the task rather than leaving it idling as billable capacity.
          running = false;
        } else {
          await sleep(pollMs);
        }
      } catch (err) {
        console.error(`[worker ${workerId}] loop error:`, errorMessage(err));
        await sleep(pollMs);
      }
    }
  })();

  return {
    workerId,
    done: loop,
    stop: async () => {
      running = false;
      await loop;
    },
  };
}
