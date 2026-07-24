import { renderReport } from "@atp/reporting";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

import type { ServerContext } from "./context";
import { loadTrace } from "./run-store";
import { findEntry } from "./tools";

/**
 * The read-only resource surface (research §8). Resources mirror the tools as addressable,
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
  server.registerResource(
    "catalog",
    "test://catalog",
    {
      title: "Test catalog",
      description: "Every test and suite in the loaded manifest.",
      mimeType: "application/json",
    },
    (uri) => jsonContents(uri, { entries: ctx.manifest.entries }),
  );

  server.registerResource(
    "test",
    new ResourceTemplate("test://{id}", { list: undefined }),
    {
      title: "Test detail",
      description: "The full manifest entry for a single test or suite id.",
      mimeType: "application/json",
    },
    (uri, variables) => {
      const entry = findEntry(ctx, scalar(variables.id));
      return jsonContents(uri, { entry });
    },
  );

  server.registerResource(
    "run-report",
    new ResourceTemplate("run://{runId}/report.md", { list: undefined }),
    {
      title: "Run report (markdown)",
      description: "The rendered markdown report for a completed run.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const trace = await loadTrace(ctx, scalar(variables.runId));
      return textContents(uri, renderReport(trace, "md"), "text/markdown");
    },
  );

  server.registerResource(
    "run-trace",
    new ResourceTemplate("run://{runId}/trace.json", { list: undefined }),
    {
      title: "Run trace (json)",
      description: "The canonical ExecutionResult trace everything else renders from.",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const trace = await loadTrace(ctx, scalar(variables.runId));
      return jsonContents(uri, trace);
    },
  );
}
