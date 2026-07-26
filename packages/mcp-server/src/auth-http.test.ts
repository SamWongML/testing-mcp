import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StoreClient } from "@atp/store";

import { PROTECTED_RESOURCE_PATH, SCOPES } from "./auth";
import type { ServerContext } from "./context";
import { getRun, submitRun } from "./tasks";
import {
  makeTestAuth,
  makeTestContext,
  makeTestDb,
  pgAvailable,
  startHttpServer,
  startTestSut,
  type HttpHandle,
  type TestAuth,
  type TestSut,
} from "./testkit";

/**
 * Auth over the wire, end to end: with
 * auth enabled the server rejects unauthenticated + under-scoped calls and admits properly
 * scoped ones, and advertises RFC 9728 metadata for discovery. Uses a real Streamable-HTTP
 * round-trip with an `Authorization` header, against the offline test authenticator.
 */
describe("auth-enabled HTTP surface", () => {
  let auth: TestAuth;
  let ctx: ServerContext;
  let http: HttpHandle;
  let sut: TestSut;

  beforeAll(async () => {
    auth = await makeTestAuth();
    sut = await startTestSut();
    ctx = await makeTestContext({
      authn: { authenticator: auth.authenticator, issuer: auth.issuer, resource: auth.resource },
    });
    http = await startHttpServer(ctx);
  });
  afterAll(async () => {
    await http.close();
    await sut.close();
  });

  const connect = async (token?: string): Promise<Client> => {
    const client = new Client({ name: "c", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${http.url}/mcp`), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    });
    await client.connect(transport);
    return client;
  };

  /** A raw JSON-RPC POST to `/mcp` — the seam the SEP-1686 `tasks/*` methods arrive on. The SDK
   * client can't easily be made to issue an unscoped `tasks/*` call, and these assertions are
   * about the HTTP gate itself, so they're made against the wire directly. */
  const rpc = (method: string, token?: string): Promise<Response> =>
    fetch(`${http.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { taskId: "any" } }),
    });

  it("serves RFC 9728 protected-resource metadata", async () => {
    const res = await fetch(`${http.url}${PROTECTED_RESOURCE_PATH}`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(doc.resource).toBe(auth.resource);
    expect(doc.authorization_servers).toEqual([auth.issuer]);
  });

  it("rejects an unauthenticated /mcp call with 401 + WWW-Authenticate", async () => {
    const res = await fetch(`${http.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate");
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata=`);
    expect(challenge).toContain(PROTECTED_RESOURCE_PATH);
  });

  it("rejects an invalid/expired token with 401", async () => {
    const expired = await auth.mint({ scopes: [SCOPES.READ], expired: true });
    const res = await fetch(`${http.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${expired}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("admits a read-scoped token to list_tests", async () => {
    const client = await connect(await auth.mint({ scopes: [SCOPES.READ] }));
    try {
      const res = (await client.callTool({ name: "list_tests", arguments: {} })) as unknown as {
        structuredContent: { entries: { id: string }[] };
      };
      expect(res.structuredContent.entries.map((e) => e.id)).toContain("alpha.create-widget");
    } finally {
      await client.close();
    }
  });

  // The SEP-1686 `tasks/*` JSON-RPC methods are handled *generically* by the SDK's `Protocol`
  // (straight into the injected `SdkTaskStore`), so they never reach a tool handler and cannot
  // be gated by `guardScope`. They are gated at the HTTP layer instead — these tests are the
  // regression barrier for that bypass.
  it("denies tasks/cancel to a read-only token — it mutates, so it needs test:run", async () => {
    const res = await rpc("tasks/cancel", await auth.mint({ scopes: [SCOPES.READ] }));
    expect(res.status).toBe(403);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain("insufficient_scope");
    expect(challenge).toContain(SCOPES.RUN);
  });

  it("denies tasks/get and tasks/result to a token carrying no scopes", async () => {
    for (const method of ["tasks/get", "tasks/result", "tasks/list"]) {
      const res = await rpc(method, await auth.mint({ scopes: [] }));
      expect(res.status, `${method} must be scope-gated`).toBe(403);
      expect(res.headers.get("WWW-Authenticate")).toContain(SCOPES.READ);
    }
  });

  it("admits tasks/get to a read-scoped token (the gate lets legitimate polls through)", async () => {
    const res = await rpc("tasks/get", await auth.mint({ scopes: [SCOPES.READ] }));
    expect(res.status).not.toBe(403); // passes the scope gate; dispatch is the server's business
  });

  it("still rejects an unauthenticated tasks/* call with 401, not 403", async () => {
    const res = await rpc("tasks/get");
    expect(res.status).toBe(401);
  });

  it("denies run_test to a read-only token (insufficient scope)", async () => {
    const client = await connect(await auth.mint({ scopes: [SCOPES.READ] }));
    try {
      const res = (await client.callTool({
        name: "run_test",
        arguments: { id: "alpha.create-widget", env: { baseUrl: sut.url } },
      })) as unknown as { isError?: boolean; content: { type: string; text: string }[] };
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain(SCOPES.RUN);
    } finally {
      await client.close();
    }
  });

  it("admits run_test to a run-scoped token", async () => {
    const client = await connect(await auth.mint({ scopes: [SCOPES.READ, SCOPES.RUN] }));
    try {
      const res = (await client.callTool({
        name: "run_test",
        arguments: { id: "alpha.create-widget", env: { baseUrl: sut.url } },
      })) as unknown as { isError?: boolean; structuredContent: { run: { status: string } } };
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent.run.status).toBe("passed");
    } finally {
      await client.close();
    }
  });
});

/**
 * The durable half of the `tasks/*` bypass. The tests above prove the HTTP
 * gate answers 403; this proves the *effect* is actually prevented — with the async surface
 * really registered (it only exists when a db is configured), an under-scoped `tasks/cancel`
 * must not reach `SdkTaskStore` and must leave the run's durable cancel flag untouched.
 */
describe.skipIf(!pgAvailable)("tasks/* authorization is enforced durably", () => {
  let auth: TestAuth;
  let store: StoreClient;
  let ctx: ServerContext;
  let http: HttpHandle;

  beforeAll(async () => {
    auth = await makeTestAuth();
    store = await makeTestDb();
    ctx = await makeTestContext({
      db: store.db,
      authn: { authenticator: auth.authenticator, issuer: auth.issuer, resource: auth.resource },
    });
    http = await startHttpServer(ctx);
  });
  afterAll(async () => {
    await http.close();
    await store.close();
  });

  it("a read-only token cannot cancel a run via raw tasks/cancel", async () => {
    const { runId } = await submitRun(ctx, { entryId: "alpha.create-widget" });
    expect((await getRun(ctx, runId))?.cancelRequested).toBe(false);

    const res = await fetch(`${http.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${await auth.mint({ scopes: [SCOPES.READ] })}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/cancel",
        params: { taskId: runId },
      }),
    });

    expect(res.status).toBe(403);
    // The decisive assertion: the durable flag was never flipped.
    expect((await getRun(ctx, runId))?.cancelRequested).toBe(false);
  });

  it("a run-scoped token still can cancel via raw tasks/cancel (the gate isn't over-broad)", async () => {
    const { runId } = await submitRun(ctx, { entryId: "alpha.create-widget" });

    const res = await fetch(`${http.url}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${await auth.mint({ scopes: [SCOPES.READ, SCOPES.RUN] })}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/cancel",
        params: { taskId: runId },
      }),
    });

    expect(res.status).not.toBe(403);
    expect((await getRun(ctx, runId))?.cancelRequested).toBe(true);
  });
});
