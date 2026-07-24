import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ServerContext } from "./context";
import { registerResources } from "./resources";
import {
  registerDescribeTest,
  registerGetReport,
  registerListRuns,
  registerListTests,
  registerRunTest,
} from "./tools";

/**
 * Build the MCP server for a given {@link ServerContext} (research §8, ADR-002). Pure and
 * stateless: it registers the tool/resource surface against the injected context and never
 * touches module-level mutable state, so a fresh server can be built per request in the
 * stateless HTTP path or once for an in-process client in tests.
 */
export function buildMcpServer(ctx: ServerContext): McpServer {
  const server = new McpServer({ name: "atp", version: "0.1.0" });
  registerListTests(server, ctx);
  registerDescribeTest(server, ctx);
  registerRunTest(server, ctx);
  registerGetReport(server, ctx);
  registerListRuns(server, ctx);
  registerResources(server, ctx);
  return server;
}
