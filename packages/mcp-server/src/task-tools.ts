import { renderReport, REPORT_FORMATS, type ReportFormat } from "@atp/reporting";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ServerContext } from "./context";
import { cancelRun, DEFAULT_TASK_TTL_MS, getRun, getRunResult, submitRun } from "./tasks";
import { findEntry, jsonResult, selectEntries, textResult } from "./tools";

/**
 * The P8 asynchronous run surface (research §8.2/§8.5). `run_suite` is task-augmented
 * (SEP-1686): a task-speaking client drives it via `tasks/get|result|cancel`, backed by the
 * {@link SdkTaskStore} adapter. `run_selection` (batch) and the `get_run`/`get_run_result`/
 * `cancel_run` mirror tools give the *same* durable semantics to clients that don't speak
 * the Tasks extension (graceful degradation) — all reading the one durable store, so a
 * `run_suite` task and a mirror-tool poll of the same `runId` observe identical state.
 *
 * Every tool here requires a configured run database; they are registered only when the
 * server is booted with one (see `buildMcpServer`).
 */

const idArg = z.string().describe('The test or suite id, e.g. "billing.e2e-refund".');
const paramsArg = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Values for the entry's params schema (see describe_test).");
const envArg = z
  .record(z.string(), z.string())
  .optional()
  .describe("Env overrides merged over the entry's baked-in env, e.g. { baseUrl }.");

/** `run_suite` — task-augmented (SEP-1686). The `createTask` handler mints a durable task +
 *  job (via the injected task store) that the worker executes; `getTask`/`getTaskResult`
 *  read the same durable run. Suites are long-running, so task augmentation is required. */
export function registerRunSuite(server: McpServer, ctx: ServerContext): void {
  server.experimental.tasks.registerToolTask(
    "run_suite",
    {
      title: "Run suite",
      description:
        "Execute a suite asynchronously as a task (SEP-1686): enqueue → worker runs the DAG → poll to a terminal state → fetch the result. Non-Task clients can mirror this via run_selection/get_run/get_run_result/cancel_run.",
      inputSchema: { id: idArg, params: paramsArg, env: envArg },
      execution: { taskSupport: "required" },
    },
    {
      createTask: async (args, extra) => {
        // Validate the target before minting a task, so a bad id fails fast with a clear
        // message rather than as a worker-side run error.
        const entry = findEntry(ctx, args.id);
        if (entry.kind !== "suite") {
          throw new Error(`"${args.id}" is a test; use run_test. run_suite executes suites.`);
        }
        // The store's createTask atomically creates the task row and enqueues the job,
        // deriving the run spec from this augmented request's arguments.
        const task = await extra.taskStore.createTask({ ttl: DEFAULT_TASK_TTL_MS });
        return { task };
      },
      getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
      // The adapter's getTaskResult builds a CallToolResult (llm_summary + verdict); the
      // RequestTaskStore types it as the generic `Result`, so narrow it back here.
      getTaskResult: async (_args, extra) =>
        (await extra.taskStore.getTaskResult(extra.taskId)) as CallToolResult,
    },
  );
}

/** `run_selection` — submit an async run for every catalog entry matching a tag/query batch,
 *  returning their run ids (poll each via `get_run`). The plain, non-Task batch surface. */
export function registerRunSelection(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "run_selection",
    {
      title: "Run selection",
      description:
        "Enqueue an asynchronous run for every catalog entry matching the given tags/query/kind, and return their run ids to poll via get_run.",
      inputSchema: {
        tags: z.array(z.string()).optional().describe("Only entries carrying all of these tags."),
        owner: z.string().optional().describe("Only entries owned by this team/owner."),
        kind: z.enum(["test", "suite"]).optional().describe("Restrict to tests or suites."),
        query: z.string().optional().describe("Case-insensitive substring over id and title."),
        params: paramsArg,
        env: envArg,
      },
    },
    async ({ tags, owner, kind, query, params, env }) => {
      const entries = selectEntries(ctx, { tags, owner, kind, query });
      if (entries.length === 0) throw new Error("selection matched no tests or suites");
      // Each submit is an independent transaction with a fresh runId — fan them out; the
      // ordered result mirrors `entries`.
      const runs = await Promise.all(
        entries.map(async (entry) => {
          const submitted = await submitRun(ctx, { entryId: entry.id, params, env });
          return { entryId: entry.id, runId: submitted.runId, state: submitted.state };
        }),
      );
      return jsonResult({ runs });
    },
  );
}

/** `get_run` — mirror of `tasks/get`: status + progress for a run id. */
export function registerGetRun(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_run",
    {
      title: "Get run",
      description:
        "Return the status and progress of an asynchronous run by id (mirrors tasks/get for non-Task clients).",
      inputSchema: {
        runId: z.string().describe("The run id returned by run_suite/run_selection."),
      },
    },
    async ({ runId }) => {
      const task = await getRun(ctx, runId);
      if (!task) throw new Error(`No run with id "${runId}"`);
      return jsonResult({
        run: {
          runId: task.runId,
          state: task.state,
          progressPct: task.progressPct,
          currentNode: task.currentNode,
          error: task.error,
          cancelRequested: task.cancelRequested,
        },
      });
    },
  );
}

/** `get_run_result` — mirror of `tasks/result`: the rendered report once the run is terminal,
 *  else the current state with `ready:false` so a poller keeps waiting. */
export function registerGetRunResult(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_run_result",
    {
      title: "Get run result",
      description:
        "Return an asynchronous run's report once it has reached a terminal state (mirrors tasks/result). Formats: markdown (default), html, junit, json, summary.",
      inputSchema: {
        runId: z.string().describe("The run id returned by run_suite/run_selection."),
        format: z
          .enum(REPORT_FORMATS as [ReportFormat, ...ReportFormat[]])
          .optional()
          .describe("Report format; defaults to markdown."),
      },
    },
    async ({ runId, format }) => {
      const fmt: ReportFormat = format ?? "md";
      const res = await getRunResult(ctx, runId);
      if (!res.ready) {
        return jsonResult({ runId, state: res.state, ready: false });
      }
      if (!res.result) {
        // Terminal, but no report was produced (cancelled while queued / errored before
        // execution) — report the state + diagnostic rather than a missing-report error.
        return jsonResult({ runId, state: res.state, ready: true, error: res.error ?? null });
      }
      return textResult(renderReport(res.result, fmt), {
        runId,
        state: res.state,
        ready: true,
        format: fmt,
      });
    },
  );
}

/** `cancel_run` — mirror of `tasks/cancel`: request cancellation of an in-flight run. */
export function registerCancelRun(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "cancel_run",
    {
      title: "Cancel run",
      description:
        "Request cancellation of an in-flight asynchronous run (mirrors tasks/cancel). The worker aborts between nodes and finalizes the run as cancelled.",
      inputSchema: { runId: z.string().describe("The run id to cancel.") },
    },
    async ({ runId }) => {
      const cancelRequested = await cancelRun(ctx, runId);
      return jsonResult({ runId, cancelRequested });
    },
  );
}
