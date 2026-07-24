import { resolve } from "node:path";

import { importDef } from "@atp/compile";
import { expandUnits, isSuite, runTest } from "@atp/engine";
import { renderReport, REPORT_FORMATS, type ReportFormat } from "@atp/reporting";
import { executionStatusSchema, type ExecutionResult, type ManifestEntry } from "@atp/schema";
import { listRuns, type Run } from "@atp/store";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { ServerContext } from "./context";
import { loadTrace, persistRun } from "./run-store";

/** A tool result: the structured payload plus a JSON text mirror. Every tool returns
 *  both — `structuredContent` for programmatic clients, `text` for ones that only read
 *  `content` (and for our own tests, which parse either). */
function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** A tool result whose primary payload is rendered text (a report), with structured
 *  metadata alongside for programmatic clients. */
function textResult(text: string, meta: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: meta };
}

/** Look an entry up by id, throwing a client-facing error if absent. A thrown `Error`
 *  is turned by the SDK into an `isError` tool result carrying the message. */
function findEntry(ctx: ServerContext, id: string): ManifestEntry {
  const entry = ctx.manifest.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`No test or suite with id "${id}"`);
  return entry;
}

/** The catalog projection of a manifest entry — the routing-relevant fields an agent
 *  needs to pick a test (research §8.2): identity, kind, tags/owner to filter on,
 *  `isLongRunning` to know it can't be run inline (P8), and the params JSON Schema. */
function catalogView(entry: ManifestEntry): Record<string, unknown> {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    tags: entry.tags,
    owner: entry.owner,
    isLongRunning: entry.isLongRunning,
    paramsSchema: entry.paramsSchema,
  };
}

/** `list_tests` — the catalog query. Filters the boot manifest by tag/owner/kind and a
 *  free-text `query` over id+title; returns id-sorted catalog views. */
export function registerListTests(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "list_tests",
    {
      title: "List tests",
      description:
        "List the catalog of available tests and suites, filterable by tags, owner, kind, or a free-text query over id and title.",
      inputSchema: {
        tags: z.array(z.string()).optional().describe("Only entries carrying all of these tags."),
        owner: z.string().optional().describe("Only entries owned by this team/owner."),
        kind: z.enum(["test", "suite"]).optional().describe("Restrict to tests or suites."),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring match over id and title."),
      },
    },
    ({ tags, owner, kind, query }) => {
      const q = query?.toLowerCase();
      const entries = ctx.manifest.entries
        .filter((e) => (tags ? tags.every((t) => e.tags.includes(t)) : true))
        .filter((e) => (owner ? e.owner === owner : true))
        .filter((e) => (kind ? e.kind === kind : true))
        .filter((e) =>
          q
            ? e.id.toLowerCase().includes(q) || (e.title?.toLowerCase().includes(q) ?? false)
            : true,
        )
        .slice()
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(catalogView);
      return jsonResult({ entries });
    },
  );
}

/** `describe_test` — the detail view. Returns the full manifest entry (nodes, params
 *  schema, env, matrix, source path) for one id, or an error result if it's unknown. */
export function registerDescribeTest(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "describe_test",
    {
      title: "Describe test",
      description:
        "Return the full manifest entry for a test or suite by id: its executable node graph, params JSON Schema, env, matrix, and authored source path.",
      inputSchema: { id: z.string().describe('The test or suite id, e.g. "identity.login".') },
    },
    ({ id }) => jsonResult({ entry: findEntry(ctx, id) }),
  );
}

/** The client-facing summary of a completed run — status + metrics for a verdict, plus
 *  the trace uri so the caller can fetch the full report (`get_report`, `run://` resources). */
function runSummary(result: ExecutionResult, artifactUri: string): Record<string, unknown> {
  return {
    runId: result.runId,
    entryId: result.entryId,
    status: result.status,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    durationMs: result.durationMs,
    metrics: result.metrics,
    error: result.error,
    artifactUri,
  };
}

/** Import the authored definition (which carries the functions the manifest strips) and
 *  execute it in-process, merging the caller's `env` over the entry's baked-in env. */
async function executeInline(
  ctx: ServerContext,
  entry: ManifestEntry,
  args: { params?: Record<string, unknown>; env?: Record<string, string> },
): Promise<ExecutionResult> {
  const def = await importDef(resolve(ctx.sourceRoot, entry.sourcePath));
  // The caller already gated on `entry.kind === "test"`; this narrows the imported union
  // and catches a manifest/module mismatch rather than casting past it.
  if (isSuite(def)) throw new Error(`"${entry.id}" resolved to a suite, not a test`);
  const unit = expandUnits(def).find((u) => u.id === entry.id);
  return runTest(def, {
    env: { ...(unit?.env ?? {}), ...(args.env ?? {}) },
    matrix: unit?.matrix ?? {},
    auth: ctx.auth,
    params: args.params,
    entryId: entry.id,
    envName: "mcp",
    manifestHash: ctx.manifest.manifestHash,
    gitSha: ctx.manifest.gitSha,
  });
}

/** `run_test` — execute one test **synchronously** and persist its trace. Rejects suites
 *  and long-running tests: those need the asynchronous task path (P8). The caller supplies
 *  `params` and an `env` override (e.g. `baseUrl` pointing at the system under test). */
export function registerRunTest(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "run_test",
    {
      title: "Run test",
      description:
        "Execute a single test synchronously against the given env and return its verdict. Persists the run's trace for later reporting. Suites and long-running tests are rejected (they use the asynchronous path).",
      inputSchema: {
        id: z.string().describe('The test id to run, e.g. "identity.login".'),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Values for the test's params schema (see describe_test)."),
        env: z
          .record(z.string(), z.string())
          .optional()
          .describe("Env overrides merged over the test's baked-in env, e.g. { baseUrl }."),
      },
    },
    async ({ id, params, env }) => {
      const entry = findEntry(ctx, id);
      if (entry.kind !== "test") {
        throw new Error(
          `"${id}" is a suite; run_test executes a single test. Suite execution is asynchronous (P8).`,
        );
      }
      if (entry.isLongRunning) {
        throw new Error(
          `"${id}" is long-running; run_test is the synchronous path. Long-running execution is asynchronous (P8).`,
        );
      }
      const result = await executeInline(ctx, entry, { params, env });
      const { traceUri } = await persistRun(ctx, result);
      return jsonResult({ run: runSummary(result, traceUri) });
    },
  );
}

/** `get_report` — render a stored run's report on demand. Loads the persisted trace by id
 *  (via the run-store pointer) and runs it through the chosen renderer (markdown default). */
export function registerGetReport(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_report",
    {
      title: "Get report",
      description:
        "Render a stored run's report by run id, in markdown (default), html, junit, json, or summary.",
      inputSchema: {
        runId: z.string().describe("The run id returned by run_test."),
        format: z
          // Derived from reporting's own format list so the two never drift.
          .enum(REPORT_FORMATS as [ReportFormat, ...ReportFormat[]])
          .optional()
          .describe("Report format; defaults to markdown."),
      },
    },
    async ({ runId, format }) => {
      const fmt: ReportFormat = format ?? "md";
      const trace = await loadTrace(ctx, runId);
      return textResult(renderReport(trace, fmt), { runId, format: fmt });
    },
  );
}

/** JSON-safe projection of a history row (Drizzle `Date` columns → ISO strings). */
function runView(row: Run): Record<string, unknown> {
  return {
    runId: row.id,
    entryId: row.entryId,
    status: row.status,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    durationMs: row.durationMs,
    manifestHash: row.manifestHash,
    gitSha: row.gitSha,
    artifactUri: row.artifactUri,
    invokedBy: row.invokedBy,
  };
}

/** `list_runs` — the run-history query (newest first). Without a configured db the history
 *  is empty (offline/dev); with one it reads `@atp/store`, filterable by entry/status/recency. */
export function registerListRuns(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "list_runs",
    {
      title: "List runs",
      description:
        "List recorded run history, newest first, filterable by entry id, status, recency, and count. Empty when no run database is configured.",
      inputSchema: {
        entryId: z.string().optional().describe("Only runs of this test/suite id."),
        status: executionStatusSchema.optional().describe("Only runs with this terminal status."),
        since: z
          .string()
          .optional()
          .describe("ISO-8601 instant; only runs started at or after it."),
        limit: z.number().int().positive().max(1000).optional().describe("Max rows (default 100)."),
      },
    },
    async ({ entryId, status, since, limit }) => {
      if (!ctx.db) return jsonResult({ runs: [] });
      const rows = await listRuns(ctx.db, {
        entryId,
        status,
        since: since ? new Date(since) : undefined,
        limit,
      });
      return jsonResult({ runs: rows.map(runView) });
    },
  );
}
