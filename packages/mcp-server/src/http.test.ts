import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestContext, startHttpServer, type HttpHandle } from "./testkit";

/**
 * A real Streamable-HTTP round-trip through the Hono app. This is the seam that proves the
 * stateless path works end to end: a fresh server + transport is built per `/mcp` request,
 * yet the MCP handshake + a tool call still complete over the wire.
 */
describe("HTTP surface", () => {
  let http: HttpHandle;
  beforeEach(async () => {
    http = await startHttpServer(await makeTestContext());
  });
  afterEach(async () => {
    await http.close();
  });

  it("answers liveness at /healthz", async () => {
    const res = await fetch(`${http.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("reports readiness with the loaded test count at /readyz", async () => {
    const res = await fetch(`${http.url}/readyz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ready", tests: 3 });
  });

  it("serves MCP over Streamable-HTTP in stateless mode", async () => {
    const client = new Client({ name: "atp-http-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`));
    await client.connect(transport);
    try {
      const res = (await client.callTool({ name: "list_tests", arguments: {} })) as unknown as {
        structuredContent: { entries: { id: string }[] };
      };
      expect(res.structuredContent.entries.map((e) => e.id)).toContain("identity.login");
    } finally {
      await client.close();
    }
  });
});
