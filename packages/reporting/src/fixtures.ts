import type { ExecutionResult, StepResult } from "@atp/schema";

/**
 * Shared `ExecutionResult` fixtures for the renderer golden-file tests (research §14).
 * One canonical typed value feeds every renderer, so a single fixture set exercises
 * markdown / html / junit / trace / summary — proving no format drifts (ADR-006).
 *
 * These are hand-authored (not engine output) so a renderer test never depends on the
 * engine; a `fixtures.test.ts` asserts each one still satisfies `executionResultSchema`.
 * Not re-exported from `index.ts` — this module is test-only scaffolding.
 */

const AT = "2026-07-23T10:00:00.000Z";

/** Build an `ExecutionResult` from a partial, filling the required scaffolding. */
export function makeResult(over: Partial<ExecutionResult> = {}): ExecutionResult {
  const steps = over.steps ?? [];
  return {
    runId: "run-1",
    entryId: "sample.test",
    kind: "test",
    status: "passed",
    steps,
    startedAt: AT,
    finishedAt: AT,
    durationMs: 0,
    metrics: {
      totalSteps: steps.length,
      passedSteps: steps.filter((s) => s.status === "passed").length,
      failedSteps: steps.filter((s) => s.status === "failed").length,
      totalAssertions: steps.reduce((n, s) => n + s.assertions.length, 0),
      failedAssertions: steps.reduce((n, s) => n + s.assertions.filter((a) => !a.ok).length, 0),
    },
    ...over,
  };
}

/** A step scaffold with the array/scalar defaults filled in. */
export function makeStep(over: Partial<StepResult> & Pick<StepResult, "id" | "status">): StepResult {
  return { assertions: [], extracted: {}, attempts: 1, ...over };
}

/** A single-test run where everything passes — the happy path. */
export const passingTest: ExecutionResult = makeResult({
  runId: "run-pass",
  entryId: "identity.login",
  status: "passed",
  env: "local",
  steps: [
    makeStep({
      id: "login",
      status: "passed",
      request: {
        method: "POST",
        url: "http://sut.local/auth/login",
        headers: { "content-type": "application/json" },
        body: { email: "qa@example.com", password: "***" },
      },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { token: "tok-1", userId: 42 },
        timingMs: 42,
      },
      assertions: [
        { ok: true, op: "eq", path: "$.status", expected: 200, actual: 200 },
        { ok: true, op: "isString", path: "$.token" },
      ],
      extracted: { token: "tok-1" },
      timingMs: 42,
    }),
  ],
  finishedAt: "2026-07-23T10:00:00.045Z",
  durationMs: 45,
  manifestHash: "sha256:abc123",
  gitSha: "deadbeef",
});

/** A suite where a mid-chain assertion fails, cascading a skip to its dependent. */
export const failingSuite: ExecutionResult = makeResult({
  runId: "run-fail-suite",
  entryId: "billing.e2e-refund",
  kind: "suite",
  status: "failed",
  env: "local",
  steps: [
    makeStep({
      id: "login",
      status: "passed",
      request: { method: "POST", url: "http://sut.local/auth/login" },
      response: { status: 200, headers: {}, body: { token: "***" }, timingMs: 30 },
      assertions: [{ ok: true, op: "eq", path: "$.status", expected: 200, actual: 200 }],
      extracted: { token: "tok" },
      timingMs: 30,
    }),
    makeStep({
      id: "refund",
      status: "passed",
      request: {
        method: "POST",
        url: "http://sut.local/payments/pay_1/refund",
        headers: { authorization: "***" },
      },
      response: { status: 201, headers: {}, body: { refundId: "rf_1" }, timingMs: 55 },
      assertions: [{ ok: true, op: "eq", path: "$.status", expected: 201, actual: 201 }],
      extracted: { refundId: "rf_1" },
      timingMs: 55,
    }),
    makeStep({
      id: "verify",
      status: "failed",
      request: { method: "GET", url: "http://sut.local/ledger/refunds/rf_1" },
      response: { status: 200, headers: {}, body: { state: "pending" }, timingMs: 120 },
      assertions: [
        {
          ok: false,
          op: "eq",
          path: "$.state",
          expected: "settled",
          actual: "pending",
          message: "ledger not yet settled",
        },
      ],
      timingMs: 120,
    }),
    makeStep({ id: "notify", status: "skipped", attempts: 0 }),
  ],
  finishedAt: "2026-07-23T10:00:00.210Z",
  durationMs: 210,
  manifestHash: "sha256:def456",
  gitSha: "cafef00d",
});

/** A single-test run that passes only after transport retries (attempts > 1). */
export const retriedTest: ExecutionResult = makeResult({
  runId: "run-retried",
  entryId: "orders.create",
  status: "passed",
  steps: [
    makeStep({
      id: "create",
      status: "passed",
      request: { method: "POST", url: "http://sut.local/orders" },
      response: { status: 201, headers: {}, body: { id: "ord_9" }, timingMs: 80 },
      assertions: [{ ok: true, op: "eq", path: "$.status", expected: 201, actual: 201 }],
      extracted: { orderId: "ord_9" },
      timingMs: 80,
      attempts: 3,
    }),
  ],
  finishedAt: "2026-07-23T10:00:00.260Z",
  durationMs: 260,
});

/** A suite cancelled mid-run: one node done, the rest cancelled before starting. */
export const cancelledRun: ExecutionResult = makeResult({
  runId: "run-cancelled",
  entryId: "billing.e2e-refund",
  kind: "suite",
  status: "cancelled",
  steps: [
    makeStep({
      id: "login",
      status: "passed",
      request: { method: "POST", url: "http://sut.local/auth/login" },
      response: { status: 200, headers: {}, body: { token: "***" }, timingMs: 30 },
      assertions: [{ ok: true, op: "eq", path: "$.status", expected: 200, actual: 200 }],
      timingMs: 30,
    }),
    makeStep({ id: "refund", status: "cancelled", attempts: 0 }),
    makeStep({ id: "verify", status: "cancelled", attempts: 0 }),
  ],
  finishedAt: "2026-07-23T10:00:00.035Z",
  durationMs: 35,
  error: "run cancelled by caller",
});

/** A larger all-passing suite — exercises the html timeline / junit multi-case path. */
export const longSuite: ExecutionResult = makeResult({
  runId: "run-long",
  entryId: "catalog.smoke",
  kind: "suite",
  status: "passed",
  env: "staging",
  steps: [
    makeStep({
      id: "auth",
      status: "passed",
      request: { method: "POST", url: "http://sut.local/auth/login" },
      response: { status: 200, headers: {}, body: { token: "***" }, timingMs: 60 },
      assertions: [{ ok: true, op: "eq", path: "$.status", expected: 200, actual: 200 }],
      timingMs: 60,
    }),
    makeStep({
      id: "list-products",
      status: "passed",
      request: { method: "GET", url: "http://sut.local/products" },
      response: { status: 200, headers: {}, body: { count: 12 }, timingMs: 140 },
      assertions: [{ ok: true, op: "gt", path: "$.count", expected: 0, actual: 12 }],
      timingMs: 140,
    }),
    makeStep({
      id: "get-product",
      status: "passed",
      request: { method: "GET", url: "http://sut.local/products/p1" },
      response: { status: 200, headers: {}, body: { id: "p1" }, timingMs: 90 },
      assertions: [{ ok: true, op: "eq", path: "$.id", expected: "p1", actual: "p1" }],
      timingMs: 90,
    }),
    makeStep({
      id: "search",
      status: "passed",
      request: { method: "GET", url: "http://sut.local/products", query: { q: "widget" } },
      response: { status: 200, headers: {}, body: { count: 3 }, timingMs: 210 },
      assertions: [{ ok: true, op: "isNumber", path: "$.count" }],
      timingMs: 210,
    }),
    makeStep({
      id: "healthz",
      status: "passed",
      request: { method: "GET", url: "http://sut.local/healthz" },
      response: { status: 200, headers: {}, body: { ok: true }, timingMs: 15 },
      assertions: [{ ok: true, op: "eq", path: "$.ok", expected: true, actual: true }],
      timingMs: 15,
    }),
  ],
  finishedAt: "2026-07-23T10:00:00.515Z",
  durationMs: 515,
  manifestHash: "sha256:0ff1ce",
  gitSha: "1234abc",
});

/** Every required scenario, for the golden-file suites to iterate over by name. */
export const allFixtures: Record<string, ExecutionResult> = {
  passingTest,
  failingSuite,
  retriedTest,
  cancelledRun,
  longSuite,
};
