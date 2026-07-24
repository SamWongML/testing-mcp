import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

import type { ManifestEntry } from "@atp/schema";
import {
  claim,
  heartbeat,
  isCancelRequested,
  type Job,
  markDone,
  PostgresTaskStore,
  reapExpired,
  type Db,
  type TaskState,
} from "@atp/store";

import type { ServerContext } from "./context";
import { executeEntry } from "./execute";
import { parseSpec, requireDb as ensureDb, resultStateFor } from "./tasks";
import { persistRun } from "./run-store";

/**
 * The async worker (research §11.2/§11.3, ADR-004). It claims queued jobs with
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
}

const DEFAULTS = { heartbeatMs: 1000, leaseMs: 30_000, pollMs: 500, reapMs: 5_000 };

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
  const tasks = new PostgresTaskStore(db);
  const runId = job.runId ?? job.id;
  const heartbeatMs = opts.heartbeatMs ?? DEFAULTS.heartbeatMs;

  // Cancel-while-queued: a job flagged before it was claimed never runs.
  if (job.cancelRequested) {
    await tasks.update(runId, { state: "cancelled" });
    await markDone(db, job.id, workerId, "done");
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

  try {
    const result = await executeEntry(ctx, entry, {
      params: spec.params,
      env: spec.env,
      runId,
      signal: controller.signal,
      onProgress: (u) => {
        const pct = u.total > 0 ? Math.round((u.completed / u.total) * 100) : 0;
        // Advisory: a transient progress-write failure must not fail an otherwise-good run,
        // so swallow per-tick errors (the terminal write is the authoritative state).
        progressChain = progressChain.then(() =>
          tasks.setProgress(runId, pct, u.nodeId).catch(() => {}),
        );
      },
    });
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
    // A cancelled/completed job is terminal (never requeue); only a failed run is 'failed'.
    await markDone(db, job.id, workerId, state === "failed" ? "failed" : "done");
    return { runId, state };
  } catch (err) {
    clearInterval(beat);
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

/** Terminal-fail a job that could not be executed (bad spec, unknown entry, unexpected throw). */
async function finalizeError(
  ctx: ServerContext,
  job: Job,
  workerId: string,
  runId: string,
  error: string,
): Promise<TaskStateResult> {
  const db = requireDb(ctx);
  await new PostgresTaskStore(db).update(runId, { state: "failed", error });
  await markDone(db, job.id, workerId, "failed");
  return { runId, state: "failed" };
}

/** Claim one ready job and run it; returns false when the queue was empty. */
export async function claimAndRun(
  ctx: ServerContext,
  workerId: string,
  opts: WorkerOptions = {},
): Promise<boolean> {
  const job = await claim(requireDb(ctx), workerId);
  if (!job) return false;
  await runClaimedJob(ctx, job, workerId, opts);
  return true;
}

/** Requeue jobs whose lease expired (crashed workers). Returns the count requeued. */
export async function reapOnce(ctx: ServerContext, leaseMs: number): Promise<number> {
  const requeued = await reapExpired(requireDb(ctx), leaseMs);
  return requeued.length;
}

export interface WorkerHandle {
  workerId: string;
  stop: () => Promise<void>;
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

  let running = true;
  let lastReap = 0;

  const loop = (async () => {
    while (running) {
      try {
        if (Date.now() - lastReap >= reapMs) {
          await reapOnce(ctx, leaseMs);
          lastReap = Date.now();
        }
        const ran = await claimAndRun(ctx, workerId, opts);
        if (!ran) await sleep(pollMs);
      } catch (err) {
        console.error(`[worker ${workerId}] loop error:`, errorMessage(err));
        await sleep(pollMs);
      }
    }
  })();

  return {
    workerId,
    stop: async () => {
      running = false;
      await loop;
    },
  };
}
