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
const TOKEN_URL = "https://auth.example.com/token";

// A global mock dispatcher shared by every describe (the pure `applyAuth` cases never
// send, so a set-but-unused agent is harmless) — mirrors suiteRunner.test.ts.
let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
});

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

function oauthProvider(id = "cc"): AuthProvider {
  return oauth2ClientCredentials({ id, tokenUrl: TOKEN_URL, clientId: "id", clientSecret: "sec" });
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

  it("bearer replaces a pre-existing same-name header case-insensitively", async () => {
    const ctx = ctxWith([bearerAuth({ id: "api", token: "new" })]);
    const req: RequestSpec = { ...BASE, authRef: "api", headers: { Authorization: "Bearer OLD" } };
    const out = await applyAuth(req, ctx);
    const authKeys = Object.keys(out.headers ?? {}).filter(
      (k) => k.toLowerCase() === "authorization",
    );
    expect(authKeys).toHaveLength(1);
    expect(header(out, "authorization")).toBe("Bearer new");
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

describe("buildAuthRegistry", () => {
  it("throws on a duplicate provider id", () => {
    expect(() =>
      buildAuthRegistry([
        bearerAuth({ id: "dup", token: "a" }),
        bearerAuth({ id: "dup", token: "b" }),
      ]),
    ).toThrow(/duplicate/);
  });
});

describe("oauth2ClientCredentials", () => {
  it("fetches a token, sets Bearer, and caches it for the run", async () => {
    // A single interceptor: if the token were fetched twice the second call would have
    // no interceptor and (net-connect disabled) throw — so a clean run proves caching.
    agent
      .get("https://auth.example.com")
      .intercept({ path: "/token", method: "POST" })
      .reply(200, { access_token: "fetched-tok" }, JSON_HEADERS);

    const ctx = ctxWith([oauthProvider()]);
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

    const ctx = ctxWith([oauthProvider()]);
    await expect(applyAuth({ ...BASE, authRef: "cc" }, ctx)).rejects.toThrow(/token/);
  });

  it("does not cache a failed token fetch — a later node retries and succeeds", async () => {
    const pool = agent.get("https://auth.example.com");
    // First fetch fails transiently; the second (after eviction) succeeds.
    pool
      .intercept({ path: "/token", method: "POST" })
      .reply(500, { error: "temporary" }, JSON_HEADERS);
    pool
      .intercept({ path: "/token", method: "POST" })
      .reply(200, { access_token: "later-tok" }, JSON_HEADERS);

    const ctx = ctxWith([oauthProvider()]);
    const req: RequestSpec = { ...BASE, authRef: "cc" };

    await expect(applyAuth(req, ctx)).rejects.toThrow(/token/);
    const ok = await applyAuth(req, ctx);
    expect(header(ok, "authorization")).toBe("Bearer later-tok");
  });
});

describe("runTest with authRef (end-to-end seam)", () => {
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

  it("redacts a secret-sourced api-key placed in the query string", async () => {
    agent
      .get("https://api.example.com")
      .intercept({ path: "/data", method: "GET", query: { api_key: "run-key" } })
      .reply(200, { ok: true }, JSON_HEADERS);

    const test = defineTest({
      id: "identity.data",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      steps: [
        {
          id: "get",
          request: { method: "GET", url: "{{env.baseUrl}}/data", authRef: "k" },
          assert: [{ path: "status", op: "eq", value: 200 }],
        },
      ],
    });

    const result = await runTest(test, {
      auth: [apiKeyAuth({ id: "k", name: "api_key", value: "{{secrets.API_KEY}}", in: "query" })],
      secrets: { API_KEY: "run-key" },
    });

    expect(result.status).toBe("passed");
    expect(result.steps[0]?.request?.query?.api_key).toBe("***");
  });

  it("cancels the step when the run aborts during the token fetch", async () => {
    agent
      .get("https://auth.example.com")
      .intercept({ path: "/token", method: "POST" })
      .reply(200, { access_token: "tok" }, JSON_HEADERS)
      .delay(100);

    const controller = new AbortController();
    const test = defineTest({
      id: "identity.whoami",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      steps: [{ id: "who", request: { method: "GET", url: "{{env.baseUrl}}/me", authRef: "cc" } }],
    });

    setTimeout(() => controller.abort(), 10);
    const result = await runTest(test, { auth: [oauthProvider()], signal: controller.signal });

    expect(result.status).toBe("cancelled");
    expect(result.steps[0]?.status).toBe("cancelled");
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
