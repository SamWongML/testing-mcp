import { describe, expect, it } from "vitest";

import {
  assertionResultSchema,
  executionResultSchema,
  executionStatusSchema,
  stepResultSchema,
} from "./result";

describe("executionStatusSchema", () => {
  it("accepts terminal run statuses", () => {
    for (const s of ["passed", "failed", "cancelled", "errored"]) {
      expect(executionStatusSchema.parse(s)).toBe(s);
    }
  });

  it("rejects a task-only in-flight status", () => {
    expect(() => executionStatusSchema.parse("working")).toThrow();
  });
});

describe("assertionResultSchema", () => {
  it("captures expected/actual for a failed declarative assertion", () => {
    const parsed = assertionResultSchema.parse({
      ok: false,
      op: "eq",
      path: "status",
      expected: 200,
      actual: 401,
      message: "unexpected status",
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.actual).toBe(401);
  });

  it("allows an fn assertion result with no op/path", () => {
    const parsed = assertionResultSchema.parse({ ok: true });
    expect(parsed.ok).toBe(true);
  });
});

describe("stepResultSchema", () => {
  it("defaults attempts, assertions and extracted", () => {
    const parsed = stepResultSchema.parse({ id: "post-login", status: "passed" });
    expect(parsed.attempts).toBe(1);
    expect(parsed.assertions).toEqual([]);
    expect(parsed.extracted).toEqual({});
  });

  it("carries a redacted request/response snapshot", () => {
    const parsed = stepResultSchema.parse({
      id: "post-login",
      status: "passed",
      request: { method: "POST", url: "/auth/login", headers: { authorization: "***" } },
      response: {
        status: 200,
        headers: { "content-type": "application/json" },
        body: { token: "***" },
      },
      timingMs: 42,
      attempts: 2,
    });
    expect(parsed.response?.status).toBe(200);
    expect(parsed.request?.headers?.authorization).toBe("***");
  });

  it("allows attempts: 0 for a skipped step (never dispatched)", () => {
    const parsed = stepResultSchema.parse({ id: "verify", status: "skipped", attempts: 0 });
    expect(parsed.attempts).toBe(0);
  });
});

describe("executionResultSchema", () => {
  it("parses a full result that records manifestHash + gitSha", () => {
    const parsed = executionResultSchema.parse({
      runId: "01J000000000000000000RUNID",
      entryId: "identity.login",
      kind: "test",
      status: "passed",
      startedAt: "2026-07-23T00:00:00.000Z",
      finishedAt: "2026-07-23T00:00:01.000Z",
      durationMs: 1000,
      steps: [{ id: "post-login", status: "passed" }],
      metrics: { totalSteps: 1, passedSteps: 1, failedSteps: 0 },
      manifestHash: "sha256:manifest",
      gitSha: "abc1234",
    });
    expect(parsed.status).toBe("passed");
    expect(parsed.metrics.passedSteps).toBe(1);
    expect(parsed.manifestHash).toBe("sha256:manifest");
  });

  it("accepts timezone-offset ISO timestamps (e.g. Postgres timestamptz)", () => {
    const parsed = executionResultSchema.parse({
      runId: "r1",
      entryId: "identity.login",
      status: "passed",
      startedAt: "2026-07-23T02:00:00+02:00",
      finishedAt: "2026-07-23T00:00:01Z",
      metrics: { totalSteps: 0, passedSteps: 0, failedSteps: 0 },
    });
    expect(parsed.startedAt).toBe("2026-07-23T02:00:00+02:00");
  });

  it("rejects a non-ISO startedAt", () => {
    expect(() =>
      executionResultSchema.parse({
        runId: "r1",
        entryId: "x",
        status: "passed",
        startedAt: "not-a-date",
        metrics: { totalSteps: 0, passedSteps: 0, failedSteps: 0 },
      }),
    ).toThrow();
  });
});
