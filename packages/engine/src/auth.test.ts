import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RequestSpec } from "@atp/schema";

import {
  apiKeyAuth,
  applyAuth,
  basicAuth,
  bearerAuth,
  buildAuthRegistry,
  customAuth,
  oauth2ClientCredentials,
} from "./auth";
import type { AuthProvider } from "./context";
import { defineTest } from "./define";
import { runTest } from "./runner";
import { createRunContext } from "./variables";

const JSON_HEADERS = { headers: { "content-type": "application/json" } };
const BASE: RequestSpec = { method: "GET", url: "https://api.example.com/data" };

function ctxWith(providers: AuthProvider[], extra: Record<string, unknown> = {}) {
  return createRunContext({ auth: buildAuthRegistry(providers), ...extra });
}

/** Case-insensitive header lookup — undici may normalize header casing. */
function header(req: RequestSpec, name: string): string | undefined {
  const entry = Object.entries(req.headers ?? {}).find(
    ([k]) => k.toLowerCase() === name.toLowerCase(),
  );
  return entry?.[1];
}

describe("applyAuth (research §10.3)", () => {
  it("passes the request through unchanged when it has no authRef", async () => {
    const out = await applyAuth(BASE, createRunContext());
    expect(out).toEqual(BASE);
  });

  it("throws on an authRef with no registered provider", async () => {
    await expect(applyAuth({ ...BASE, authRef: "missing" }, createRunContext())).rejects.toThrow(
      /missing/,
    );
  });

  it("bearer sets an Authorization: Bearer header", async () => {
    const ctx = ctxWith([bearerAuth({ id: "api", token: "tok-123" })]);
    const out = await applyAuth({ ...BASE, authRef: "api" }, ctx);
    expect(header(out, "authorization")).toBe("Bearer tok-123");
  });

  it("bearer resolves a templated token from secrets", async () => {
    const ctx = ctxWith([bearerAuth({ id: "api", token: "{{secrets.API_TOKEN}}" })], {
      secrets: { API_TOKEN: "s3cr3t" },
    });
    const out = await applyAuth({ ...BASE, authRef: "api" }, ctx);
    expect(header(out, "authorization")).toBe("Bearer s3cr3t");
  });

  it("basic sets a base64 Authorization: Basic header", async () => {
    const ctx = ctxWith([basicAuth({ id: "b", username: "alice", password: "pw" })]);
    const out = await applyAuth({ ...BASE, authRef: "b" }, ctx);
    expect(header(out, "authorization")).toBe(
      `Basic ${Buffer.from("alice:pw").toString("base64")}`,
    );
  });

  it("api-key sets a header by default", async () => {
    const ctx = ctxWith([apiKeyAuth({ id: "k", name: "x-api-key", value: "abc" })]);
    const out = await applyAuth({ ...BASE, authRef: "k" }, ctx);
    expect(header(out, "x-api-key")).toBe("abc");
  });

  it("api-key can be placed in the query string", async () => {
    const ctx = ctxWith([apiKeyAuth({ id: "k", name: "api_key", value: "abc", in: "query" })]);
    const out = await applyAuth({ ...BASE, authRef: "k" }, ctx);
    expect(out.query?.api_key).toBe("abc");
    expect(out.headers?.api_key).toBeUndefined();
  });

  it("custom applies an arbitrary transform", async () => {
    const ctx = ctxWith([
      customAuth({
        id: "c",
        apply: (req) => ({ ...req, headers: { ...(req.headers ?? {}), "x-signed": "yes" } }),
      }),
    ]);
    const out = await applyAuth({ ...BASE, authRef: "c" }, ctx);
    expect(header(out, "x-signed")).toBe("yes");
  });
});

describe("oauth2ClientCredentials", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it("fetches a token, sets Bearer, and caches it for the run", async () => {
    // A single interceptor: if the token were fetched twice the second call would have
    // no interceptor and (net-connect disabled) throw — so a clean run proves caching.
    agent
      .get("https://auth.example.com")
      .intercept({ path: "/token", method: "POST" })
      .reply(200, { access_token: "fetched-tok" }, JSON_HEADERS);

    const provider = oauth2ClientCredentials({
      id: "cc",
      tokenUrl: "https://auth.example.com/token",
      clientId: "id",
      clientSecret: "sec",
      scope: "read",
    });
    const ctx = ctxWith([provider]);
    const req: RequestSpec = { ...BASE, authRef: "cc" };

    const first = await applyAuth(req, ctx);
    const second = await applyAuth(req, ctx);

    expect(header(first, "authorization")).toBe("Bearer fetched-tok");
    expect(header(second, "authorization")).toBe("Bearer fetched-tok");
    agent.assertNoPendingInterceptors();
  });

  it("errors when the token endpoint returns no access_token", async () => {
    agent
      .get("https://auth.example.com")
      .intercept({ path: "/token", method: "POST" })
      .reply(401, { error: "invalid_client" }, JSON_HEADERS);

    const ctx = ctxWith([
      oauth2ClientCredentials({
        id: "cc",
        tokenUrl: "https://auth.example.com/token",
        clientId: "id",
        clientSecret: "sec",
      }),
    ]);
    await expect(applyAuth({ ...BASE, authRef: "cc" }, ctx)).rejects.toThrow(/token/);
  });
});

describe("runTest with authRef (end-to-end seam)", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
  });

  it("resolves authRef so the Authorization header reaches the SUT, then redacts it", async () => {
    let receivedAuth: string | undefined;
    agent
      .get("https://api.example.com")
      .intercept({ path: "/me", method: "GET" })
      .reply((opts) => {
        const h = opts.headers as Record<string, string>;
        receivedAuth = h.authorization ?? h.Authorization;
        return {
          statusCode: 200,
          data: JSON.stringify({ ok: true }),
          responseOptions: JSON_HEADERS,
        };
      });

    const test = defineTest({
      id: "identity.whoami",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      steps: [
        {
          id: "who",
          request: { method: "GET", url: "{{env.baseUrl}}/me", authRef: "api" },
          assert: [{ path: "status", op: "eq", value: 200 }],
        },
      ],
    });

    const result = await runTest(test, {
      auth: [bearerAuth({ id: "api", token: "{{secrets.TOKEN}}" })],
      secrets: { TOKEN: "run-token" },
    });

    expect(result.status).toBe("passed");
    expect(receivedAuth).toBe("Bearer run-token");
    // The persisted request snapshot masks the auth header wholesale.
    expect(result.steps[0]?.request?.headers?.authorization).toBe("***");
  });

  it("errors the step when its authRef has no registered provider", async () => {
    const test = defineTest({
      id: "identity.whoami",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      steps: [
        {
          id: "who",
          request: { method: "GET", url: "{{env.baseUrl}}/me", authRef: "api" },
        },
      ],
    });

    const result = await runTest(test);
    expect(result.status).toBe("errored");
    expect(result.steps[0]?.error).toMatch(/api/);
  });
});
