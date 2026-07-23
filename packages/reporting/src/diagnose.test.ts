import { describe, expect, it } from "vitest";

import { diagnose } from "./diagnose";
import { failingSuite, makeResult, makeStep, passingTest } from "./fixtures";

describe("diagnose (likely-cause heuristic)", () => {
  it("returns undefined for a passing run", () => {
    expect(diagnose(passingTest)).toBeUndefined();
  });

  it("classifies a 401 response as auth", () => {
    const d = diagnose(
      makeResult({
        status: "failed",
        steps: [
          makeStep({
            id: "me",
            status: "failed",
            response: { status: 401, headers: {}, body: { error: "unauthorized" } },
            assertions: [{ ok: false, op: "eq", path: "$.status", expected: 200, actual: 401 }],
          }),
        ],
      }),
    );
    expect(d?.cause).toBe("auth");
    expect(d?.stepId).toBe("me");
    expect(d?.detail).toContain("401");
  });

  it("classifies a 403 response as auth", () => {
    const d = diagnose(
      makeResult({
        status: "failed",
        steps: [makeStep({ id: "x", status: "failed", response: { status: 403, headers: {} } })],
      }),
    );
    expect(d?.cause).toBe("auth");
  });

  it("classifies a 5xx response as server-error", () => {
    const d = diagnose(
      makeResult({
        status: "failed",
        steps: [makeStep({ id: "x", status: "failed", response: { status: 503, headers: {} } })],
      }),
    );
    expect(d?.cause).toBe("server-error");
    expect(d?.detail).toContain("503");
  });

  it("classifies an errored step whose error mentions a timeout", () => {
    const d = diagnose(
      makeResult({
        status: "errored",
        steps: [makeStep({ id: "slow", status: "errored", error: "request timed out after 5000ms" })],
      }),
    );
    expect(d?.cause).toBe("timeout");
  });

  it("classifies an errored step whose error mentions a connection failure", () => {
    const d = diagnose(
      makeResult({
        status: "errored",
        steps: [makeStep({ id: "down", status: "errored", error: "fetch failed: ECONNREFUSED" })],
      }),
    );
    expect(d?.cause).toBe("network");
  });

  it("classifies a failed jsonSchema assertion as schema-mismatch", () => {
    const d = diagnose(
      makeResult({
        status: "failed",
        steps: [
          makeStep({
            id: "shape",
            status: "failed",
            response: { status: 200, headers: {}, body: {} },
            assertions: [{ ok: false, op: "jsonSchema", path: "$", message: "missing 'id'" }],
          }),
        ],
      }),
    );
    expect(d?.cause).toBe("schema-mismatch");
  });

  it("classifies a plain failed assertion as assertion-failed, with expected/actual detail", () => {
    const d = diagnose(failingSuite);
    expect(d?.cause).toBe("assertion-failed");
    expect(d?.stepId).toBe("verify");
    expect(d?.detail).toContain("settled");
    expect(d?.detail).toContain("pending");
  });

  it("classifies a whole-suite timeout as timeout (not cancelled)", () => {
    // The engine records a suite `timeoutMs` breach as an `errored` run whose in-flight
    // node reads as `cancelled` (runner.ts) — the run error carries the timeout signal.
    const d = diagnose(
      makeResult({
        status: "errored",
        error: 'suite "billing.e2e" exceeded timeoutMs (2000ms)',
        steps: [
          makeStep({ id: "login", status: "passed" }),
          makeStep({ id: "slow-refund", status: "cancelled", attempts: 1 }),
        ],
      }),
    );
    expect(d?.cause).toBe("timeout");
    expect(d?.detail).toContain("exceeded timeoutMs");
    expect(d?.nextAction).toContain("timeoutMs");
  });

  it("classifies a suite timeout that fired after every node passed", () => {
    // No non-passing step remains, so the run-level error must drive the classification.
    const d = diagnose(
      makeResult({
        status: "errored",
        error: 'suite "billing.e2e" exceeded timeoutMs (2000ms)',
        steps: [makeStep({ id: "a", status: "passed" }), makeStep({ id: "b", status: "passed" })],
      }),
    );
    expect(d?.cause).toBe("timeout");
  });

  it("classifies a cancelled run", () => {
    const d = diagnose(
      makeResult({
        status: "cancelled",
        error: "run cancelled by caller",
        steps: [makeStep({ id: "a", status: "cancelled", attempts: 0 })],
      }),
    );
    expect(d?.cause).toBe("cancelled");
  });

  it("always supplies a next action", () => {
    const d = diagnose(failingSuite);
    expect(d?.nextAction).toBeTruthy();
  });
});
