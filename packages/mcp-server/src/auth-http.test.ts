import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PROTECTED_RESOURCE_PATH, SCOPES } from "./auth";
import type { ServerContext } from "./context";
import {
  makeTestAuth,
  makeTestContext,
  startHttpServer,
  startTestSut,
  type HttpHandle,
  type TestAuth,
  type TestSut,
} from "./testkit";

/**
 * Auth over the wire (research §15, ADR-007). Proves the P10 exit criterion end to end: with
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
      expect(res.structuredContent.entries.map((e) => e.id)).toContain("identity.login");
    } finally {
      await client.close();
    }
  });

  it("denies run_test to a read-only token (insufficient scope)", async () => {
    const client = await connect(await auth.mint({ scopes: [SCOPES.READ] }));
    try {
      const res = (await client.callTool({
        name: "run_test",
        arguments: { id: "identity.login", env: { baseUrl: sut.url } },
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
        arguments: { id: "identity.login", env: { baseUrl: sut.url } },
      })) as unknown as { isError?: boolean; structuredContent: { run: { status: string } } };
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent.run.status).toBe("passed");
    } finally {
      await client.close();
    }
  });
});
