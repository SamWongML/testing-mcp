import { randomUUID } from "node:crypto";

import { renderReport } from "@atp/reporting";
import { type Db, enqueue, PostgresTaskStore, type TaskRecord } from "@atp/store";
import type {
  CreateTaskOptions,
  TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks/interfaces.js";
import type {
  CallToolResult,
  Request,
  RequestId,
  Result,
  Task,
} from "@modelcontextprotocol/sdk/types.js";

import type { ServerContext } from "./context";
import {
  cancelRun,
  DEFAULT_TASK_TTL_MS,
  getRun,
  getRunResult,
  requireDb,
  type RunSpec,
} from "./tasks";
import { runSummary } from "./tools";

/**
 * The bridge between the experimental MCP Tasks protocol (SEP-1686) and our durable stage-1
 * store. The SDK calls this `TaskStore` to service `tasks/get|result|cancel` and to mint a
 * task on a task-augmented `tools/call`; every method reads/writes the **same** Postgres
 * `tasks` + `jobs` rows the worker uses, so a task created here is executed by a separate
 * worker process and its state/result flow back through here. Because it is durable and
 * keyed by `runId` (== `taskId`), it works across the stateless server's fresh-per-request
 * lifecycle — no session affinity (ADR-002).
 *
 * Only `run_suite`/`run_selection`-style tool calls are task-augmented; the adapter derives
 * the {@link RunSpec} to enqueue from the augmented request's tool arguments.
 */
export class SdkTaskStore implements TaskStore {
  constructor(private readonly ctx: ServerContext) {}

  private db(): Db {
    return requireDb(this.ctx, "no run database configured");
  }

  private store(): PostgresTaskStore {
    return new PostgresTaskStore(this.db());
  }

  async createTask(
    taskParams: CreateTaskOptions,
    _requestId: RequestId,
    request: Request,
    _sessionId?: string,
  ): Promise<Task> {
    const runId = randomUUID();
    const ttl = taskParams.ttl === undefined ? DEFAULT_TASK_TTL_MS : taskParams.ttl; // null ⇒ no TTL
    const spec = runSpecFromRequest(request);

    // Atomic: create the working task row and enqueue its job together, so a task is never
    // minted without a job (which no worker would ever run).
    const rec = await this.db().transaction(async (tx) => {
      const created = await new PostgresTaskStore(tx).create({
        runId,
        state: "working",
        progressPct: 0,
        ...(ttl === null ? {} : { ttlMs: ttl }),
      });
      if (!created) throw new Error(`task id collision for ${runId}`);
      await enqueue(tx, { runId, spec });
      return created;
    });
    return toSdkTask(rec);
  }

  async getTask(taskId: string, _sessionId?: string): Promise<Task | null> {
    const rec = await getRun(this.ctx, taskId);
    return rec ? toSdkTask(rec) : null;
  }

  async getTaskResult(taskId: string, _sessionId?: string): Promise<Result> {
    const res = await getRunResult(this.ctx, taskId);
    if (!res.ready) throw new Error(`Task "${taskId}" has no result yet (${res.state})`);
    if (!res.result) {
      // Terminal but no trace (cancelled while queued, or an error before execution): return
      // the terminal state + diagnostic rather than failing to load an absent trace.
      const payload: CallToolResult = {
        content: [{ type: "text", text: res.error ?? `run ${res.state}` }],
        structuredContent: { runId: taskId, status: res.state, error: res.error ?? null },
        isError: res.state === "failed",
      };
      return payload;
    }
    // Match the tools/call result shape (llm_summary text + the run_test verdict payload) so a
    // task-speaking client gets the same result as the synchronous run_test tool.
    const payload: CallToolResult = {
      content: [{ type: "text", text: renderReport(res.result, "summary") }],
      structuredContent: runSummary(res.result, res.artifactUri ?? ""),
      isError: res.result.status !== "passed",
    };
    return payload;
  }

  async storeTaskResult(
    taskId: string,
    status: "completed" | "failed",
    _result: Result,
    _sessionId?: string,
  ): Promise<void> {
    // The worker owns the terminal write (it also persists the trace the result renders
    // from), so this is only a defensive reflection of state for SDK-internal flows.
    await this.store().update(taskId, { state: status });
  }

  async updateTaskStatus(
    taskId: string,
    status: Task["status"],
    statusMessage?: string,
    _sessionId?: string,
  ): Promise<void> {
    if (status === "cancelled") {
      // Flag the job + task; the worker aborts the in-flight run and writes the terminal
      // `cancelled` state (research §11.2). Don't force terminal here — a queued job is
      // finalized at claim time, a running one when its abort lands.
      await cancelRun(this.ctx, taskId);
      return;
    }
    await this.store().update(taskId, { state: status, error: statusMessage });
  }

  async listTasks(
    _cursor?: string,
    _sessionId?: string,
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    // `tasks/list` is registered by the SDK whenever a task store is configured (regardless of
    // the advertised `list` capability), so a client can reach this directly; we don't back a
    // real listing in stage-1 (deferred), so it returns empty rather than erroring.
    return { tasks: [] };
  }
}

/** How often a task-streaming client re-polls `tasks/get` — advertised on every `Task` so
 *  polling stays fast for the whole run, not just after creation. */
const POLL_INTERVAL_MS = 500;

/** Project a durable {@link TaskRecord} onto the SEP-1686 `Task` shape the protocol returns. */
function toSdkTask(rec: TaskRecord): Task {
  const ttl = rec.expiresAt ? rec.expiresAt.getTime() - rec.createdAt.getTime() : null;
  const task: Task = {
    taskId: rec.runId,
    status: rec.state,
    ttl,
    createdAt: rec.createdAt.toISOString(),
    lastUpdatedAt: rec.updatedAt.toISOString(),
    pollInterval: POLL_INTERVAL_MS,
  };
  if (rec.error) task.statusMessage = rec.error;
  return task;
}

/** Derive the run spec to enqueue from a task-augmented `tools/call` request's arguments. */
function runSpecFromRequest(request: Request): RunSpec {
  const args = (request.params?.arguments ?? {}) as {
    id?: unknown;
    params?: Record<string, unknown>;
    env?: Record<string, string>;
  };
  if (typeof args.id !== "string") {
    throw new Error("task-augmented run requires a string `id` argument");
  }
  return { entryId: args.id, params: args.params, env: args.env };
}
