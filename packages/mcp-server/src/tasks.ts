import { randomUUID } from "node:crypto";

import type { ExecutionResult, ExecutionStatus } from "@atp/schema";
import {
  type Db,
  enqueue,
  PostgresTaskStore,
  requestCancel as requestJobCancel,
  type TaskRecord,
  type TaskState,
} from "@atp/store";

import type { ServerContext } from "./context";
import { loadTrace } from "./run-store";

/**
 * Task-lifecycle glue (SEP-1686 §11.1) mapping the async run surface onto P6's durable
 * queue (`jobs`) + hot task state (`tasks`). A submission durably enqueues a job **and**
 * creates the `working` task row in one transaction; the worker later claims the job, runs
 * the engine, and drives the task to a terminal state. `getRun`/`getRunResult`/`cancelRun`
 * are the read/cancel side the MCP tools (and the SDK task adapter) share.
 *
 * The whole surface requires a configured Postgres — async execution is inherently durable.
 */

/** How long a completed task's result is retained before the TTL sweep may reap it. */
export const DEFAULT_TASK_TTL_MS = 24 * 60 * 60 * 1000;

/** The serializable run spec stored in `jobs.spec` — everything the worker needs to execute
 *  an entry. `entryId` addresses the manifest; the worker derives kind from the entry. */
export interface RunSpec {
  entryId: string;
  params?: Record<string, unknown>;
  env?: Record<string, string>;
}

/** Narrow the opaque `jobs.spec` jsonb back to a `RunSpec` (defensive — a malformed spec is
 *  a worker-side error, surfaced as a failed run rather than a crash). */
export function parseSpec(spec: unknown): RunSpec {
  if (typeof spec !== "object" || spec === null || !("entryId" in spec)) {
    throw new Error("job spec is missing entryId");
  }
  const s = spec as Record<string, unknown>;
  if (typeof s.entryId !== "string") throw new Error("job spec entryId must be a string");
  return {
    entryId: s.entryId,
    params: (s.params as Record<string, unknown> | undefined) ?? undefined,
    env: (s.env as Record<string, string> | undefined) ?? undefined,
  };
}

/** Map an engine `ExecutionStatus` onto the SEP-1686 terminal `TaskState`. A run that
 *  errored (an infra/config fault) is reported as a failed task — the distinction is kept
 *  in the persisted result's own `status`/`error`. */
export function resultStateFor(status: ExecutionStatus): TaskState {
  switch (status) {
    case "passed":
      return "completed";
    case "cancelled":
      return "cancelled";
    default:
      return "failed"; // failed | errored
  }
}

/** Require a configured db for the async path, with a client-facing message. Shared by the
 *  worker and the SDK task adapter (which pass their own message). */
export function requireDb(
  ctx: ServerContext,
  message = "asynchronous runs require a configured run database (set DATABASE_URL)",
): Db {
  if (!ctx.db) throw new Error(message);
  return ctx.db;
}

export interface SubmitRunInput extends RunSpec {
  /** Dedupe key: a resubmission with the same key returns the original run instead of
   *  enqueuing a duplicate (idempotency, research §16.2). Becomes the `runId`. */
  idempotencyKey?: string;
  /** Higher runs first in the queue. */
  priority?: number;
  /** Result-retention TTL; defaults to {@link DEFAULT_TASK_TTL_MS}. */
  ttlMs?: number;
}

export interface SubmittedRun {
  runId: string;
  state: TaskState;
  /** True when an existing run was returned for a repeated idempotency key. */
  deduped: boolean;
}

/**
 * Durably submit a run: atomically create the `working` task row and enqueue its job. When
 * `idempotencyKey` names an already-submitted run, the insert-only task `create` no-ops and
 * the existing run is returned (`deduped`) — no second job is enqueued.
 */
export async function submitRun(ctx: ServerContext, input: SubmitRunInput): Promise<SubmittedRun> {
  const db = requireDb(ctx);
  const runId = input.idempotencyKey ?? randomUUID();
  const spec: RunSpec = { entryId: input.entryId, params: input.params, env: input.env };

  return db.transaction(async (tx) => {
    const tasks = new PostgresTaskStore(tx);
    const created = await tasks.create({
      runId,
      state: "working",
      progressPct: 0,
      ttlMs: input.ttlMs ?? DEFAULT_TASK_TTL_MS,
    });
    if (!created) {
      // Idempotent hit: a task with this runId already exists — return it, enqueue nothing.
      const existing = await tasks.get(runId);
      return { runId, state: existing?.state ?? "working", deduped: true };
    }
    await enqueue(tx, { runId, spec, priority: input.priority });
    return { runId, state: created.state, deduped: false };
  });
}

/** Fetch a run's hot task state (status + progress), or null if unknown. */
export async function getRun(ctx: ServerContext, runId: string): Promise<TaskRecord | null> {
  return new PostgresTaskStore(requireDb(ctx)).get(runId);
}

const TERMINAL: ReadonlySet<TaskState> = new Set(["completed", "failed", "cancelled"]);
export const isTerminalState = (state: TaskState): boolean => TERMINAL.has(state);

export interface RunResult {
  runId: string;
  state: TaskState;
  /** True once the run reached a terminal state (whether or not it produced a trace). */
  ready: boolean;
  /** The terminal `ExecutionResult`, present when the run executed and persisted a trace. */
  result?: ExecutionResult;
  /** Pointer to the persisted artifacts, present when a trace was written. */
  artifactUri?: string;
  /** Terminal diagnostic when the run produced no trace (cancelled while still queued, or an
   *  error before execution) — surfaced instead of the absent report. */
  error?: string;
}

/**
 * Fetch a run's terminal outcome once available. While the run is still `working`, returns
 * `{ ready: false }`. Once terminal, a run that executed carries its `ExecutionResult` (loaded
 * from the persisted trace); a run that reached a terminal state *without* producing a trace —
 * cancelled while still queued, or errored before execution (`finalizeError`) — is `ready`
 * with no `result`, carrying the task's diagnostic in `error`. `task.resultRef` is the
 * discriminator: it is set only on the paths that call `persistRun`.
 */
export async function getRunResult(ctx: ServerContext, runId: string): Promise<RunResult> {
  const task = await getRun(ctx, runId);
  if (!task) throw new Error(`No run with id "${runId}"`);
  if (!isTerminalState(task.state)) return { runId, state: task.state, ready: false };
  if (!task.resultRef) {
    return { runId, state: task.state, ready: true, error: task.error ?? undefined };
  }
  const result = await loadTrace(ctx, runId);
  return { runId, state: task.state, ready: true, result, artifactUri: task.resultRef };
}

/** Request cancellation: flag the job (so a running worker aborts between nodes) and the
 *  task row. The worker finalizes the terminal `cancelled` state. Returns whether a
 *  non-terminal run was flagged. */
export async function cancelRun(ctx: ServerContext, runId: string): Promise<boolean> {
  const db = requireDb(ctx);
  const tasks = new PostgresTaskStore(db);
  const task = await tasks.get(runId);
  if (!task || isTerminalState(task.state)) return false;
  const jobFlagged = await requestJobCancel(db, runId);
  await tasks.requestCancel(runId);
  return jobFlagged;
}
