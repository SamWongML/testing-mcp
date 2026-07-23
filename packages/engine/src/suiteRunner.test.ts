import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executionResultSchema } from "@atp/schema";

import { defineSuite, defineTest, useStep, useTest } from "./define";
import { expandUnits } from "./matrix";
import { runSuite } from "./runner";

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

describe("runSuite — §7.2 billing.e2e-refund (adapted to MockAgent)", () => {
  it("runs the full login→order→capture→refund→verify chain, composing by reference", async () => {
    const pool = agent.get("https://api.example.com");
    pool
      .intercept({ path: "/auth/login", method: "POST" })
      .reply(200, { token: "tok-1" }, JSON_HEADERS);
    // Only matches when the token from `auth` flowed through useStep's `with` → {{params.token}}.
    pool
      .intercept({ path: "/orders", method: "POST", headers: { authorization: "Bearer tok-1" } })
      .reply(201, { paymentId: "pay-1" }, JSON_HEADERS);
    pool
      .intercept({ path: "/payments/pay-1/capture", method: "POST" })
      .reply(200, { ok: true }, JSON_HEADERS);
    pool
      .intercept({ path: "/payments/pay-1/refund", method: "POST" })
      .reply(202, { id: "ref-1" }, JSON_HEADERS);
    // Eventual consistency: the ledger settles only on the second read — verify must poll.
    pool
      .intercept({ path: "/ledger/refunds/ref-1", method: "GET" })
      .reply(200, { status: "pending" }, JSON_HEADERS);
    pool
      .intercept({ path: "/ledger/refunds/ref-1", method: "GET" })
      .reply(200, { status: "settled" }, JSON_HEADERS);

    // A reused test (independently runnable) — the suite overrides its `email` param.
    const login = defineTest({
      id: "identity.login",
      version: 1,
      params: (z) => z.object({ email: z.string().default("qa@example.com") }),
      steps: [
        {
          id: "post",
          request: {
            method: "POST",
            url: "{{env.baseUrl}}/auth/login",
            body: { email: "{{params.email}}" },
          },
          extract: [{ as: "authToken", from: "body.token" }],
        },
      ],
    });

    // A reusable shared step — bound inputs arrive as {{params.*}} (research §7.2 / §13.1).
    const createOrder = {
      id: "create-order",
      request: {
        method: "POST" as const,
        url: "{{env.baseUrl}}/orders",
        headers: { authorization: "Bearer {{params.token}}" },
      },
      extract: [{ as: "paymentId", from: "body.paymentId" }],
    };

    const suite = defineSuite({
      id: "billing.e2e-refund",
      version: 3,
      title: "Create order → capture → refund → verify ledger",
      tags: ["billing", "e2e"],
      timeoutMs: 120_000,
      env: { baseUrl: "https://api.example.com" },
      nodes: {
        auth: useTest(login, { params: { email: "billing-bot@example.com" } }),
        order: useStep(createOrder, {
          needs: ["auth"],
          with: { token: "{{nodes.auth.authToken}}" },
        }),
        capture: {
          needs: ["order"],
          request: {
            method: "POST",
            url: "{{env.baseUrl}}/payments/{{nodes.order.paymentId}}/capture",
          },
          assert: [{ path: "status", op: "eq", value: 200 }],
        },
        refund: {
          needs: ["capture"],
          request: {
            method: "POST",
            url: "{{env.baseUrl}}/payments/{{nodes.order.paymentId}}/refund",
          },
          assert: [{ path: "status", op: "eq", value: 202 }],
          extract: [{ as: "refundId", from: "body.id" }],
        },
        verify: {
          needs: ["refund"],
          request: {
            method: "GET",
            url: "{{env.baseUrl}}/ledger/refunds/{{nodes.refund.refundId}}",
          },
          assert: [{ path: "body.status", op: "eq", value: "settled" }],
          poll: { untilAssertPasses: true, intervalMs: 10, maxMs: 1000 },
        },
      },
    });

    const result = await runSuite(suite);

    expect(result.status).toBe("passed");
    expect(result.kind).toBe("suite");
    expect(result.entryId).toBe("billing.e2e-refund");
    // Topologically ordered, single dependency chain.
    expect(result.steps.map((s) => s.id)).toEqual(["auth", "order", "capture", "refund", "verify"]);
    expect(result.steps.every((s) => s.status === "passed")).toBe(true);
    expect(result.metrics.totalSteps).toBe(5);
    // Param override on the reused `login` reached the request body.
    expect(result.steps.find((s) => s.id === "auth")?.request?.body).toEqual({
      email: "billing-bot@example.com",
    });
    // useStep bound the chained token into the shared step's {{params.token}}: the /orders
    // mock only matched `Bearer tok-1`, so a passing `order` proves the token flowed —
    // while the persisted snapshot is redacted to `***` (credential-at-rest, §21).
    expect(result.steps.find((s) => s.id === "order")?.status).toBe("passed");
    expect(result.steps.find((s) => s.id === "order")?.request?.headers?.authorization).toBe("***");
    // Poll re-read the ledger until it settled (first read was `pending`).
    expect(
      (result.steps.find((s) => s.id === "verify")?.response?.body as { status: string }).status,
    ).toBe("settled");
    // Validate the contract downstream renderers depend on.
    expect(() => executionResultSchema.parse(result)).not.toThrow();
  });
});

describe("runSuite — DAG scheduling", () => {
  it("runs independent branches and merges them (diamond DAG)", async () => {
    const pool = agent.get("https://api.example.com");
    pool.intercept({ path: "/start", method: "GET" }).reply(200, { seed: "s" }, JSON_HEADERS);
    pool.intercept({ path: "/left", method: "GET" }).reply(200, { l: "L" }, JSON_HEADERS);
    pool.intercept({ path: "/right", method: "GET" }).reply(200, { r: "R" }, JSON_HEADERS);
    pool.intercept({ path: "/merge", method: "POST" }).reply(200, { ok: true }, JSON_HEADERS);

    const suite = defineSuite({
      id: "diamond",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      nodes: {
        start: {
          request: { method: "GET", url: "{{env.baseUrl}}/start" },
          extract: [{ as: "seed", from: "body.seed" }],
        },
        left: {
          needs: ["start"],
          request: { method: "GET", url: "{{env.baseUrl}}/left" },
          extract: [{ as: "l", from: "body.l" }],
        },
        right: {
          needs: ["start"],
          request: { method: "GET", url: "{{env.baseUrl}}/right" },
          extract: [{ as: "r", from: "body.r" }],
        },
        merge: {
          needs: ["left", "right"],
          request: {
            method: "POST",
            url: "{{env.baseUrl}}/merge",
            body: { l: "{{nodes.left.l}}", r: "{{nodes.right.r}}" },
          },
          assert: [{ path: "status", op: "eq", value: 200 }],
        },
      },
    });

    const result = await runSuite(suite);

    expect(result.status).toBe("passed");
    // merge only passes if both parallel branches published their extracts into the
    // shared nodes bag before it ran — the resolved request snapshot proves it.
    expect(result.steps.find((s) => s.id === "merge")?.request?.body).toEqual({ l: "L", r: "R" });
  });

  it("skips dependents of a failed node but still runs independent branches", async () => {
    const pool = agent.get("https://api.example.com");
    pool.intercept({ path: "/a", method: "GET" }).reply(200, { ok: true }, JSON_HEADERS);
    pool.intercept({ path: "/b", method: "GET" }).reply(500, "boom");
    pool.intercept({ path: "/c", method: "GET" }).reply(200, { ok: true }, JSON_HEADERS);
    // No intercept for /d — proves the skipped node is never requested.

    const suite = defineSuite({
      id: "skip",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      nodes: {
        a: { request: { method: "GET", url: "{{env.baseUrl}}/a" } },
        b: {
          needs: ["a"],
          request: { method: "GET", url: "{{env.baseUrl}}/b" },
          assert: [{ path: "status", op: "eq", value: 200 }],
        },
        c: {
          needs: ["a"],
          request: { method: "GET", url: "{{env.baseUrl}}/c" },
          assert: [{ path: "status", op: "eq", value: 200 }],
        },
        d: { needs: ["b"], request: { method: "GET", url: "{{env.baseUrl}}/d" } },
      },
    });

    const result = await runSuite(suite);

    expect(result.status).toBe("failed");
    const byId = Object.fromEntries(result.steps.map((s) => [s.id, s.status]));
    expect(byId).toEqual({ a: "passed", b: "failed", c: "passed", d: "skipped" });
  });

  it("returns an errored result (not a throw) for a structurally invalid suite", async () => {
    const suite = defineSuite({
      id: "cyclic",
      version: 1,
      nodes: {
        a: { needs: ["b"], request: { method: "GET", url: "/a" } },
        b: { needs: ["a"], request: { method: "GET", url: "/b" } },
      },
    });

    const result = await runSuite(suite);
    expect(result.status).toBe("errored");
    expect(result.error).toMatch(/cycle/i);
  });
});

describe("runSuite — cancellation & timeout", () => {
  it("cancels every node when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const suite = defineSuite({
      id: "cancel",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      nodes: {
        a: { request: { method: "GET", url: "{{env.baseUrl}}/a" } },
        b: { needs: ["a"], request: { method: "GET", url: "{{env.baseUrl}}/b" } },
      },
    });

    const result = await runSuite(suite, { signal: controller.signal });
    expect(result.status).toBe("cancelled");
    expect(result.steps.map((s) => s.status)).toEqual(["cancelled", "cancelled"]);
    expect(result.steps.every((s) => s.attempts === 0)).toBe(true);
  });

  it("cancels the in-flight node and its pending dependents when aborted mid-suite", async () => {
    agent
      .get("https://api.example.com")
      .intercept({ path: "/slow", method: "GET" })
      .reply(200, "late")
      .delay(100);

    const controller = new AbortController();
    const suite = defineSuite({
      id: "cancel-mid",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      nodes: {
        a: { request: { method: "GET", url: "{{env.baseUrl}}/slow" } },
        b: { needs: ["a"], request: { method: "GET", url: "{{env.baseUrl}}/b" } },
      },
    });

    setTimeout(() => controller.abort(), 10);
    const result = await runSuite(suite, { signal: controller.signal });

    expect(result.status).toBe("cancelled");
    const byId = Object.fromEntries(result.steps.map((s) => [s.id, s.status]));
    expect(byId.a).toBe("cancelled");
    expect(byId.b).toBe("cancelled");
  });

  it("errors the run when the suite timeoutMs budget is exceeded", async () => {
    agent
      .get("https://api.example.com")
      .intercept({ path: "/slow", method: "GET" })
      .reply(200, "late")
      .delay(200);

    const suite = defineSuite({
      id: "budget",
      version: 1,
      timeoutMs: 20,
      env: { baseUrl: "https://api.example.com" },
      nodes: { a: { request: { method: "GET", url: "{{env.baseUrl}}/slow" } } },
    });

    const result = await runSuite(suite);
    expect(result.status).toBe("errored");
    expect(result.error).toMatch(/timeoutMs|exceeded/i);
  });
});

describe("runSuite — concurrency, skip cascade & redaction", () => {
  it("falls back to the default (does not hang) when concurrency is 0", async () => {
    agent
      .get("https://api.example.com")
      .intercept({ path: "/a", method: "GET" })
      .reply(200, { ok: true }, JSON_HEADERS);

    const suite = defineSuite({
      id: "zero-concurrency",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      nodes: { a: { request: { method: "GET", url: "{{env.baseUrl}}/a" } } },
    });

    // A 0 limit must not deadlock the scheduler — it runs to completion.
    const result = await runSuite(suite, { concurrency: 0 });
    expect(result.status).toBe("passed");
    expect(result.steps.map((s) => s.status)).toEqual(["passed"]);
  });

  it("honors the concurrency limit — concurrency:1 serializes independent branches", async () => {
    const pool = agent.get("https://api.example.com");
    for (const path of ["/x", "/y", "/z"]) {
      pool.intercept({ path, method: "GET" }).reply(200, { ok: true }, JSON_HEADERS).delay(40);
    }

    const suite = defineSuite({
      id: "serial",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      nodes: {
        x: { request: { method: "GET", url: "{{env.baseUrl}}/x" } },
        y: { request: { method: "GET", url: "{{env.baseUrl}}/y" } },
        z: { request: { method: "GET", url: "{{env.baseUrl}}/z" } },
      },
    });

    const started = performance.now();
    const result = await runSuite(suite, { concurrency: 1 });
    const elapsed = performance.now() - started;

    expect(result.status).toBe("passed");
    // Three 40ms nodes run one at a time ⇒ ≥ ~120ms. Parallel would finish in ~40ms, so a
    // comfortably-below-serial bound proves the limit is honored (load only slows it more).
    expect(elapsed).toBeGreaterThan(100);
  });

  it("skips a node when only some of its multiple needs passed", async () => {
    const pool = agent.get("https://api.example.com");
    pool.intercept({ path: "/ok", method: "GET" }).reply(200, { ok: true }, JSON_HEADERS);
    pool.intercept({ path: "/bad", method: "GET" }).reply(500, "boom");
    // No intercept for /m — it depends on a failed node and must never be requested.

    const suite = defineSuite({
      id: "partial-needs",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      nodes: {
        ok: { request: { method: "GET", url: "{{env.baseUrl}}/ok" } },
        bad: {
          request: { method: "GET", url: "{{env.baseUrl}}/bad" },
          assert: [{ path: "status", op: "eq", value: 200 }],
        },
        m: { needs: ["ok", "bad"], request: { method: "GET", url: "{{env.baseUrl}}/m" } },
      },
    });

    const result = await runSuite(suite);
    expect(result.status).toBe("failed");
    const byId = Object.fromEntries(result.steps.map((s) => [s.id, s.status]));
    expect(byId).toEqual({ ok: "passed", bad: "failed", m: "skipped" });
  });

  it("redacts suite-level secret values in persisted request snapshots", async () => {
    agent
      .get("https://api.example.com")
      .intercept({ path: "/login", method: "POST" })
      .reply(200, { ok: true }, JSON_HEADERS);

    const suite = defineSuite({
      id: "redact-suite",
      version: 1,
      env: { baseUrl: "https://api.example.com" },
      nodes: {
        login: {
          request: {
            method: "POST",
            url: "{{env.baseUrl}}/login",
            body: { password: "{{secrets.PW}}" },
          },
        },
      },
    });

    const result = await runSuite(suite, { secrets: { PW: "s3cret" } });
    expect(result.status).toBe("passed");
    expect(result.steps[0]?.request?.body).toEqual({ password: "***" });
  });
});

describe("runSuite — matrix cell execution (§7.3)", () => {
  it("populates {{matrix.*}} across suite nodes and applies the per-cell env", async () => {
    agent
      .get("https://eu.api.example.com")
      .intercept({ path: "/ping/eu", method: "GET" })
      .reply(200, { ok: true }, JSON_HEADERS);

    const suite = defineSuite({
      id: "region.smoke",
      version: 1,
      matrix: { region: ["us", "eu"] },
      env: (m) => ({ baseUrl: `https://${String(m.region)}.api.example.com` }),
      nodes: {
        ping: {
          request: { method: "GET", url: "{{env.baseUrl}}/ping/{{matrix.region}}" },
          assert: [{ path: "status", op: "eq", value: 200 }],
        },
      },
    });

    const euCell = expandUnits(suite).find((u) => u.matrix.region === "eu");
    const result = await runSuite(suite, {
      entryId: euCell?.id,
      matrix: euCell?.matrix,
      env: euCell?.env,
    });

    expect(result.status).toBe("passed");
    expect(result.entryId).toBe("region.smoke#region=eu");
    expect(result.steps[0]?.request?.url).toBe("https://eu.api.example.com/ping/eu");
  });
});
