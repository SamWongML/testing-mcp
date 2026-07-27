import { renderReport } from "@atp/reporting";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import { SCOPES } from "./auth";
import type { ServerContext } from "./context";
import { resourceErrors } from "./errors";
import { guardScope } from "./guard";
import { loadTrace } from "./run-store";
import { DEFAULT_PAGE_SIZE, findEntry, paginate } from "./tools";

/**
 * The read-only resource surface. Resources mirror the tools as addressable,
 * cacheable URIs: `test://catalog` and `test://{id}` expose the boot manifest; the
 * `run://{runId}/…` templates expose a persisted run's report and canonical trace. Every
 * read resolves against the injected {@link ServerContext} only — no per-request state.
 */

/** RFC-6570 template variables come back as `string | string[]`; take the scalar. */
function scalar(v: Variables[string] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
}

function textContents(uri: URL, text: string, mimeType: string): ReadResourceResult {
  return { contents: [{ uri: uri.href, mimeType, text }] };
}

function jsonContents(uri: URL, payload: unknown): ReadResourceResult {
  return textContents(uri, JSON.stringify(payload), "application/json");
}

export function registerResources(server: McpServer, ctx: ServerContext): void {
  /** One id-sorted page of the manifest, plus the cursor for the next. Shared by the fixed
   * first-page URI and the cursor template so both answer the same shape. */
  const catalogPage = (cursor?: string): Record<string, unknown> => {
    const sorted = [...ctx.manifest.entries].sort((a, b) => a.id.localeCompare(b.id));
    const { page, nextCursor } = paginate(sorted, { cursor });
    return { entries: page, ...(nextCursor ? { nextCursor } : {}) };
  };

  server.registerResource(
    "catalog",
    "test://catalog",
    {
      title: "Test catalog",
      description:
        `The first page of the loaded manifest (${DEFAULT_PAGE_SIZE} entries), id-sorted, ` +
        "with a nextCursor when more remain — read test://catalog/{cursor} for the rest. " +
        "Paged because the corpus is designed to grow to thousands of entries.",
      mimeType: "application/json",
    },
    resourceErrors((uri, extra) => {
      guardScope(ctx, extra, SCOPES.READ);
      return jsonContents(uri, catalogPage());
    }),
  );

  server.registerResource(
    "catalog-page",
    new ResourceTemplate("test://catalog/{cursor}", { list: undefined }),
    {
      title: "Test catalog (page)",
      description: "A further page of the manifest, addressed by an opaque nextCursor.",
      mimeType: "application/json",
    },
    resourceErrors((uri, variables, extra) => {
      guardScope(ctx, extra, SCOPES.READ);
      return jsonContents(uri, catalogPage(scalar(variables.cursor)));
    }),
  );

  server.registerResource(
    "test",
    new ResourceTemplate("test://{id}", { list: undefined }),
    {
      title: "Test detail",
      description: "The full manifest entry for a single test or suite id.",
      mimeType: "application/json",
    },
    resourceErrors((uri, variables, extra) => {
      guardScope(ctx, extra, SCOPES.READ);
      const entry = findEntry(ctx, scalar(variables.id));
      return jsonContents(uri, { entry });
    }),
  );

  server.registerResource(
    "run-report",
    new ResourceTemplate("run://{runId}/report.md", { list: undefined }),
    {
      title: "Run report (markdown)",
      description: "The rendered markdown report for a completed run.",
      mimeType: "text/markdown",
    },
    resourceErrors(async (uri, variables, extra) => {
      guardScope(ctx, extra, SCOPES.READ);
      const trace = await loadTrace(ctx, scalar(variables.runId));
      return textContents(uri, renderReport(trace, "md"), "text/markdown");
    }),
  );

  server.registerResource(
    "run-trace",
    new ResourceTemplate("run://{runId}/trace.json", { list: undefined }),
    {
      title: "Run trace (json)",
      description: "The canonical ExecutionResult trace everything else renders from.",
      mimeType: "application/json",
    },
    resourceErrors(async (uri, variables, extra) => {
      guardScope(ctx, extra, SCOPES.READ);
      const trace = await loadTrace(ctx, scalar(variables.runId));
      return jsonContents(uri, trace);
    }),
  );
}
