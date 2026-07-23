import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executionResultSchema } from "@atp/schema";

import type { EngineResponse } from "./context";
import { defineTest } from "./define";
import { runTest } from "./runner";

const JSON_HEADERS = { headers: { "content-type": "application/json" } };

let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
});

describe("runTest — happy path (research §7.1)", () => {
  const login = defineTest({
    id: "identity.login",
    version: 1,
    title: "User can log in and receive a token",
    tags: ["identity", "auth", "smoke"],
    timeoutMs: 15_000,
    env: { baseUrl: "https://api.example.com" },
    params: (z) =>
      z.object({
        email: z.string().default("qa@example.com"),
        password: z.string().default("{{secrets.QA_PASSWORD}}"),
      }),
    steps: [
      {
        id: "post-login",
        request: {
          method: "POST",
          url: "{{env.baseUrl}}/auth/login",
          headers: { "content-type": "application/json" },
          body: { email: "{{params.email}}", password: "{{params.password}}" },
        },
        assert: [
          { path: "status", op: "eq", value: 200 },
          { path: "body.token", op: "isString" },
          { path: "headers.content-type", op: "contains", value: "application/json" },
          {
            fn: (res) =>
              (res as EngineResponse).body != null &&
              (res as { body: { expiresIn: number } }).body.expiresIn > 0,
            message: "token must not be expired",
          },
        ],
        extract: [
          { as: "authToken", from: "body.token" },
          { as: "userId", from: "body.user.id" },
        ],
        retry: { max: 2, backoffMs: 0, on: ["network", "5xx"] },
      },
    ],
  });

  it("produces a passing, schema-valid ExecutionResult", async () => {
    agent
      .get("https://api.example.com")
      .intercept({ path: "/auth/login", method: "POST" })
      .reply(200, { token: "tok-abc", user: { id: "u1" }, expiresIn: 3600 }, JSON_HEADERS);

    const result = await runTest(login, { secrets: { QA_PASSWORD: "hunter2" } });

    expect(result.status).toBe("passed");
    expect(result.entryId).toBe("identity.login");
    expect(result.kind).toBe("test");
    expect(result.steps[0]?.status).toBe("passed");
    expect(result.steps[0]?.extracted).toEqual({ authToken: "tok-abc", userId: "u1" });
    expect(result.metrics).toMatchObject({
      totalSteps: 1,
      passedSteps: 1,
      totalAssertions: 4,
      failedAssertions: 0,
    });
    // runTest validates internally; re-parse to prove the contract for downstream renderers.
    expect(() => executionResultSchema.parse(result)).not.toThrow();
  });

  it("reports a failing assertion as a failed run", async () => {
    agent
      .get("https://api.example.com")
      .intercept({ path: "/auth/login", method: "POST" })
      .reply(200, { token: 123, user: { id: "u1" }, expiresIn: 3600 }, JSON_HEADERS);

    const result = await runTest(login, { secrets: { QA_PASSWORD: "hunter2" } });
    expect(result.status).toBe("failed");
    expect(result.steps[0]?.assertions.find((a) => a.path === "body.token")?.ok).toBe(false);
    expect(result.metrics.failedAssertions).toBeGreaterThan(0);
  });
});

describe("runTest — retry", () => {
  it("retries on 5xx up to the policy max, then succeeds", async () => {
    const pool = agent.get("https://api.example.com");
    pool.intercept({ path: "/flaky", method: "GET" }).reply(503, "down").times(2);
    pool.intercept({ path: "/flaky", method: "GET" }).reply(200, { ok: true }, JSON_HEADERS);

    const test = defineTest({
      id: "flaky",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      steps: [
        {
          id: "get",
          request: { method: "GET", url: "{{env.baseUrl}}/flaky" },
          assert: [{ path: "status", op: "eq", value: 200 }],
          retry: { max: 2, backoffMs: 0, on: ["5xx"] },
        },
      ],
    });

    const result = await runTest(test);
    expect(result.status).toBe("passed");
    expect(result.steps[0]?.attempts).toBe(3);
  });
});

describe("runTest — chaining via extract + {{nodes.X.var}}", () => {
  it("passes an extracted value from one step into the next", async () => {
    const pool = agent.get("https://api.example.com");
    pool
      .intercept({ path: "/auth/login", method: "POST" })
      .reply(200, { token: "tok-1" }, JSON_HEADERS);
    // Only matches when the Authorization header carries the extracted token.
    pool
      .intercept({ path: "/me", method: "GET", headers: { authorization: "Bearer tok-1" } })
      .reply(200, { id: "u1" }, JSON_HEADERS);

    const test = defineTest({
      id: "chain",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      steps: [
        {
          id: "login",
          request: { method: "POST", url: "{{env.baseUrl}}/auth/login" },
          extract: [{ as: "token", from: "body.token" }],
        },
        {
          id: "me",
          request: {
            method: "GET",
            url: "{{env.baseUrl}}/me",
            headers: { authorization: "Bearer {{nodes.login.token}}" },
          },
          assert: [{ path: "body.id", op: "eq", value: "u1" }],
        },
      ],
    });

    const result = await runTest(test);
    expect(result.status).toBe("passed");
    expect(result.steps.map((s) => s.status)).toEqual(["passed", "passed"]);
  });
});

describe("runTest — redaction", () => {
  it("masks secret values in persisted request snapshots", async () => {
    agent
      .get("https://api.example.com")
      .intercept({ path: "/login", method: "POST" })
      .reply(200, { ok: true }, JSON_HEADERS);

    const test = defineTest({
      id: "redact",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      steps: [
        {
          id: "login",
          request: {
            method: "POST",
            url: "{{env.baseUrl}}/login",
            body: { password: "{{secrets.PW}}" },
          },
        },
      ],
    });

    const result = await runTest(test, { secrets: { PW: "s3cret" } });
    expect(result.steps[0]?.request?.body).toEqual({ password: "***" });
  });
});

describe("runTest — timeout", () => {
  it("errors the step when the per-step timeout fires", async () => {
    agent
      .get("https://api.example.com")
      .intercept({ path: "/slow", method: "GET" })
      .reply(200, "late")
      .delay(50);

    const test = defineTest({
      id: "slow",
      version: 1,
      timeoutMs: 5,
      env: { baseUrl: "https://api.example.com" },
      steps: [{ id: "get", request: { method: "GET", url: "{{env.baseUrl}}/slow" } }],
    });

    const result = await runTest(test);
    expect(result.status).toBe("errored");
    expect(result.steps[0]?.status).toBe("errored");
    expect(result.steps[0]?.error).toBeTruthy();
  });
});

describe("runTest — cancellation", () => {
  it("marks steps cancelled when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const test = defineTest({
      id: "cancel",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      steps: [{ id: "get", request: { method: "GET", url: "{{env.baseUrl}}/x" } }],
    });

    const result = await runTest(test, { signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(result.steps[0]?.status).toBe("cancelled");
    expect(result.steps[0]?.attempts).toBe(0);
  });
});
