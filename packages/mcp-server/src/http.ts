import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { ServerContext } from "./context";
import { buildMcpServer } from "./server";

/**
 * The HTTP surface (research §8, ADR-002). MCP is served at `/mcp` over the Streamable-HTTP
 * transport in **stateless** mode: a fresh server + transport is built per request and
 * discarded, so no session state crosses requests. `/healthz` is liveness (the process is
 * up); `/readyz` is readiness (the manifest loaded, so the surface can answer).
 */
export function createHttpApp(ctx: ServerContext): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"],
      exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
    }),
  );

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", (c) => c.json({ status: "ready", tests: ctx.manifest.entries.length }));

  app.all("/mcp", async (c) => {
    const server = buildMcpServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });

  return app;
}
