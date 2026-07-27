import { renderReport, REPORT_FORMATS, type ReportFormat } from "@atp/reporting";
import { executionStatusSchema, type ExecutionResult, type ManifestEntry } from "@atp/schema";
import { listRuns, type Run } from "@atp/store";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { SCOPES } from "./auth";
import type { ServerContext } from "./context";
import { executeEntry } from "./execute";
import { auditRun, guardScope } from "./guard";
import { loadTrace, persistRun } from "./run-store";
import { submitRun } from "./tasks";

/** A tool result: the structured payload plus a JSON text mirror. Every tool returns
 * both — `structuredContent` for programmatic clients, `text` for ones that only read
 * `content` (and for our own tests, which parse either). */
export function jsonResult(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/** A tool result whose primary payload is rendered text (a report), with structured
 * metadata alongside for programmatic clients. */
export function textResult(text: string, meta: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: meta };
}

/** Look an entry up by id, throwing a client-facing error if absent. A thrown `Error`
 * is turned by the SDK into an `isError` tool result carrying the message. */
export function findEntry(ctx: ServerContext, id: string): ManifestEntry {
  const entry = ctx.manifest.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`No test or suite with id "${id}"`);
  return entry;
}

/** The catalog projection of a manifest entry — the routing-relevant fields an agent
 * needs to pick a test: identity, kind, tags/owner to filter on,
 * `isLongRunning` to know it can't be run inline, and the params JSON Schema. */
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

/**
 * Annotations for the tools that only ever read. The protocol's defaults are deliberately
 * pessimistic — `destructiveHint` and `openWorldHint` both default to **true** — so an
 * unannotated `list_tests` is indistinguishable to a client from one that mutates a remote
 * system. Declaring the read-only set is what lets a caller treat them as safe; the
 * run tools keep the conservative defaults, which are already correct for them.
 */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

/** Default page size for catalog listings. The corpus is designed to grow to thousands of
 * entries, and an unbounded array here is marshaled per request straight into a calling
 * agent's context window. */
export const DEFAULT_PAGE_SIZE = 200;
export const MAX_PAGE_SIZE = 1000;

/**
 * Cursors are opaque by spec — a client must not parse, modify, or persist them. Ours is a
 * keyset over the id-sorted catalog (base64 of the last id returned), which stays correct as
 * entries are added or removed, unlike an offset.
 */
export function encodeCursor(lastId: string): string {
  return Buffer.from(lastId, "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  // An unparseable cursor is a client error worth naming, not a silent reset to page 1.
  if (!decoded) throw new Error(`Invalid cursor "${cursor}"`);
  return decoded;
}

/** Take one page after `cursor` from an id-sorted list, plus the cursor for the next. */
export function paginate<T extends { id: string }>(
  sorted: T[],
  opts: { limit?: number; cursor?: string } = {},
): { page: T[]; nextCursor?: string } {
  const after = decodeCursor(opts.cursor);
  const start = after === undefined ? 0 : sorted.findIndex((e) => e.id > after);
  if (start < 0) return { page: [] };
  const limit = Math.min(opts.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const page = sorted.slice(start, start + limit);
  const last = page[page.length - 1];
  const more = last !== undefined && start + page.length < sorted.length;
  return { page, nextCursor: more ? encodeCursor(last.id) : undefined };
}

/** The catalog filter shared by `list_tests` and `run_selection`: tag/owner/kind plus a
 * free-text `query` over id+title. Returns matching entries, id-sorted. */
export interface EntryFilter {
  tags?: string[];
  owner?: string;
  kind?: "test" | "suite";
  query?: string;
}

export function selectEntries(ctx: ServerContext, filter: EntryFilter): ManifestEntry[] {
  const q = filter.query?.toLowerCase();
  return ctx.manifest.entries
    .filter((e) => (filter.tags ? filter.tags.every((t) => e.tags.includes(t)) : true))
    .filter((e) => (filter.owner ? e.owner === filter.owner : true))
    .filter((e) => (filter.kind ? e.kind === filter.kind : true))
    .filter((e) =>
      q ? e.id.toLowerCase().includes(q) || (e.title?.toLowerCase().includes(q) ?? false) : true,
    )
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** `list_tests` — the catalog query. Filters the boot manifest by tag/owner/kind and a
 * free-text `query` over id+title; returns id-sorted catalog views. */
export function registerListTests(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "list_tests",
    {
      title: "List tests",
      description:
        "List the catalog of available tests and suites, filterable by tags, owner, kind, or a free-text query over id and title.",
      annotations: READ_ONLY,
      inputSchema: {
        tags: z.array(z.string()).optional().describe("Only entries carrying all of these tags."),
        owner: z.string().optional().describe("Only entries owned by this team/owner."),
        kind: z.enum(["test", "suite"]).optional().describe("Restrict to tests or suites."),
        query: z
          .string()
          .optional()
          .describe("Case-insensitive substring match over id and title."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_PAGE_SIZE)
          .optional()
          .describe(`Max entries per page (default ${DEFAULT_PAGE_SIZE}).`),
        cursor: z
          .string()
          .optional()
          .describe("Opaque cursor from a previous call's nextCursor; omit for the first page."),
      },
    },
    ({ tags, owner, kind, query, limit, cursor }, extra) => {
      guardScope(ctx, extra, SCOPES.READ);
      const matched = selectEntries(ctx, { tags, owner, kind, query });
      const { page, nextCursor } = paginate(matched, { limit, cursor });
      // `nextCursor` absent means "end of results" — that is the protocol's signal, so it is
      // omitted rather than sent as null.
      return jsonResult({ entries: page.map(catalogView), ...(nextCursor ? { nextCursor } : {}) });
    },
  );
}

/** `describe_test` — the detail view. Returns the full manifest entry (nodes, params
 * schema, env, matrix, source path) for one id, or an error result if it's unknown. */
export function registerDescribeTest(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "describe_test",
    {
      title: "Describe test",
      annotations: READ_ONLY,
      description:
        "Return the full manifest entry for a test or suite by id: its executable node graph, params JSON Schema, env, matrix, and authored source path.",
      inputSchema: { id: z.string().describe('The test or suite id, e.g. "identity.login".') },
    },
    ({ id }, extra) => {
      guardScope(ctx, extra, SCOPES.READ);
      return jsonResult({ entry: findEntry(ctx, id) });
    },
  );
}

/** The client-facing summary of a completed run — status + metrics for a verdict, plus
 * the trace uri so the caller can fetch the full report (`get_report`, `run://` resources).
 * Shared by the sync `run_test` result and the async task-result payload so both match. */
export function runSummary(result: ExecutionResult, artifactUri: string): Record<string, unknown> {
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

/** `run_test` — execute one test and return its verdict. A fast test runs **synchronously**
 * and persists its trace; a long-running test is **auto-enqueued** as a durable async run
 * (returning a `runId` to poll via `get_run`/`get_run_result`). Suites always use the async
 * path (`run_suite`). The caller supplies `params` and an `env` override (e.g. `baseUrl`). */
export function registerRunTest(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "run_test",
    {
      title: "Run test",
      description:
        "Execute a single test against the given env. Fast tests run synchronously and return a verdict; long-running tests are enqueued as an async run (poll get_run / get_run_result by the returned runId). Suites use run_suite.",
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
    async ({ id, params, env }, extra) => {
      guardScope(ctx, extra, SCOPES.RUN);
      const entry = findEntry(ctx, id);
      if (entry.kind !== "test") {
        throw new Error(`"${id}" is a suite; use run_suite (suite execution is asynchronous).`);
      }
      await auditRun(ctx, extra, { action: "run_test", entryId: id, params });
      if (entry.isLongRunning) {
        // Auto-task: a long-running test is enqueued for the worker rather than blocking the
        // request. Requires a configured run database (the async path is durable).
        if (!ctx.db) {
          throw new Error(
            `"${id}" is long-running and needs the asynchronous path, which requires a configured run database (set DATABASE_URL).`,
          );
        }
        const submitted = await submitRun(ctx, { entryId: id, params, env });
        return jsonResult({
          run: { runId: submitted.runId, state: submitted.state, async: true },
        });
      }
      const result = await executeEntry(ctx, entry, { params, env });
      const { traceUri } = await persistRun(ctx, result);
      return jsonResult({ run: runSummary(result, traceUri) });
    },
  );
}

/** `get_report` — render a stored run's report on demand. Loads the persisted trace by id
 * (via the run-store pointer) and runs it through the chosen renderer (markdown default). */
export function registerGetReport(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_report",
    {
      title: "Get report",
      annotations: READ_ONLY,
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
    async ({ runId, format }, extra) => {
      guardScope(ctx, extra, SCOPES.READ);
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
 * is empty (offline/dev); with one it reads `@atp/store`, filterable by entry/status/recency. */
export function registerListRuns(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "list_runs",
    {
      title: "List runs",
      annotations: READ_ONLY,
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
    async ({ entryId, status, since, limit }, extra) => {
      guardScope(ctx, extra, SCOPES.READ);
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
