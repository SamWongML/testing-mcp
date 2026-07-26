import type { ExecutionResult, StepResult } from "@atp/schema";
import { describe, expect, it } from "vitest";

import { goldenAssertions, goldenFromResult, renderAssertions } from "./golden";

/**
 * Golden-master parity (step 4): capture a baseline response for a migrated
 * request, derive assertions that prove a re-run reproduces it (status + key-field shape).
 */
describe("goldenAssertions — baseline → parity assertions", () => {
  it("asserts the status exactly", () => {
    const asserts = goldenAssertions({ status: 201, body: {} });
    expect(asserts).toContainEqual({ path: "status", op: "eq", value: 201 });
  });

  it("derives shape assertions for scalar key fields", () => {
    const asserts = goldenAssertions({
      status: 200,
      body: { token: "abc", expiresIn: 3600, ok: true },
    });
    // Strings/numbers assert type (values vary run-to-run); booleans assert the exact value.
    expect(asserts).toContainEqual({ path: "body.token", op: "isString" });
    expect(asserts).toContainEqual({ path: "body.expiresIn", op: "isNumber" });
    expect(asserts).toContainEqual({ path: "body.ok", op: "eq", value: true });
  });

  it("does not fabricate assertions for nested objects/arrays it cannot compare field-wise", () => {
    const asserts = goldenAssertions({ status: 200, body: { user: { id: 1 }, items: [1, 2] } });
    const paths = asserts.map((a) => a.path);
    expect(paths).not.toContain("body.user");
    expect(paths).not.toContain("body.items");
  });
});

describe("renderAssertions — TS source for pasting into a migrated test", () => {
  it("renders an assertion array literal", () => {
    const src = renderAssertions([{ path: "status", op: "eq", value: 200 }]);
    expect(src).toContain('{ path: "status", op: "eq", value: 200 }');
  });
});

/** A minimal `ExecutionResult` around `steps` — the shape `goldenFromResult` reads. Status and
 *  metrics are derived from `steps` rather than hardcoded, so the fixture never claims
 *  something the steps contradict (a later test may read fields this one doesn't). */
function resultOf(steps: StepResult[]): ExecutionResult {
  const count = (status: StepResult["status"]) => steps.filter((s) => s.status === status).length;
  return {
    runId: "run-1",
    entryId: "petstore.billing",
    status: count("passed") === steps.length ? "passed" : "failed",
    steps,
    startedAt: "2026-07-26T00:00:00Z",
    runAttempt: 1,
    metrics: {
      totalSteps: steps.length,
      passedSteps: count("passed"),
      failedSteps: count("failed"),
      totalAssertions: 0,
      failedAssertions: 0,
    },
  };
}

describe("goldenFromResult — a captured run → per-node parity blocks", () => {
  it("emits one block per executed node, keyed by node id", () => {
    const { blocks, missing } = goldenFromResult(
      resultOf([
        {
          id: "get-invoice",
          status: "passed",
          response: { status: 200, headers: {}, body: { id: "inv_1", amount: 4200 } },
          assertions: [],
          extracted: {},
          attempts: 1,
        },
      ]),
    );

    expect(missing).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.nodeId).toBe("get-invoice");
    expect(blocks[0]!.source).toContain('{ path: "status", op: "eq", value: 200 }');
    expect(blocks[0]!.source).toContain('{ path: "body.id", op: "isString" }');
    expect(blocks[0]!.source).toContain('{ path: "body.amount", op: "isNumber" }');
  });

  it("refuses to emit for a node that did not execute, reporting it as missing", () => {
    // A skipped node has no response: deriving parity assertions from a partial run would
    // silently pin the wrong thing, so the node is reported instead of guessed at.
    const { blocks, missing } = goldenFromResult(
      resultOf([
        {
          id: "get-invoice",
          status: "failed",
          response: { status: 404, headers: {}, body: { error: "nope" } },
          assertions: [],
          extracted: {},
          attempts: 1,
        },
        { id: "refund-invoice", status: "skipped", assertions: [], extracted: {}, attempts: 0 },
        { id: "verify-refund", status: "cancelled", assertions: [], extracted: {}, attempts: 0 },
      ]),
    );

    // The node that really ran is emitted — a 404 is what the SUT does, and that is the
    // baseline worth pinning. Its downstream neighbours never ran, so they are refused.
    expect(blocks.map((b) => b.nodeId)).toEqual(["get-invoice"]);
    expect(blocks[0]!.source).toContain('{ path: "status", op: "eq", value: 404 }');
    expect(missing).toEqual(["refund-invoice", "verify-refund"]);
  });
});
