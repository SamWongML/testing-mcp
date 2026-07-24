import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ServerContext } from "./context";
import { registerPrompts } from "./prompts";
import { registerResources } from "./resources";
import { SdkTaskStore } from "./sdk-tasks";
import {
  registerCancelRun,
  registerGetRun,
  registerGetRunResult,
  registerRunSelection,
  registerRunSuite,
} from "./task-tools";
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
 *
 * When a run database is configured the asynchronous surface is enabled: the server
 * advertises the Tasks capability with a durable {@link SdkTaskStore} (so `run_suite` is a
 * real SEP-1686 task and `tasks/get|result|cancel` work), and registers the mirror tools
 * (`run_selection`/`get_run`/`get_run_result`/`cancel_run`) for non-Task clients. Without a
 * db the server is synchronous-only (the P7 surface) since async runs need durable state.
 */
export function buildMcpServer(ctx: ServerContext): McpServer {
  const asyncEnabled = Boolean(ctx.db);
  const server = new McpServer(
    { name: "atp", version: "0.1.0" },
    asyncEnabled
      ? {
          capabilities: { tasks: { cancel: {}, requests: { tools: { call: {} } } } },
          taskStore: new SdkTaskStore(ctx),
        }
      : undefined,
  );
  registerListTests(server, ctx);
  registerDescribeTest(server, ctx);
  registerRunTest(server, ctx);
  registerGetReport(server, ctx);
  registerListRuns(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  if (asyncEnabled) {
    registerRunSuite(server, ctx);
    registerRunSelection(server, ctx);
    registerGetRun(server, ctx);
    registerGetRunResult(server, ctx);
    registerCancelRun(server, ctx);
  }
  return server;
}
