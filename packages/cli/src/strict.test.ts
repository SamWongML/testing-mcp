import type { Assertion, Manifest, ManifestEntry, Step } from "@atp/schema";
import { describe, expect, it } from "vitest";

import { strictViolations } from "./strict";

/** Build a one-entry manifest around `nodes` — the shape `strictViolations` operates on. */
function manifestOf(nodes: Array<Partial<Step> & Pick<Step, "id" | "request">>): Manifest {
  const entry: ManifestEntry = {
    id: "demo.entry",
    kind: "test",
    version: 1,
    tags: [],
    isLongRunning: false,
    sourcePath: "tests/demo/entry.test.ts",
    nodes: nodes.map((n) => ({ assert: [], extract: [], needs: [], ...n })),
  };
  return { schemaVersion: "1.0", gitSha: "abc123", manifestHash: "sha256:x", entries: [entry] };
}

describe("strictViolations — non-pinning status assertion", () => {
  it("flags the scaffolder's `status lt 500` assertion, which accepts any 4xx", () => {
    const violations = strictViolations(
      manifestOf([
        {
          id: "get-order",
          request: { method: "GET", url: "https://api.example/orders/1" },
          assert: [{ path: "status", op: "lt", value: 500 }],
        },
      ]),
    );

    expect(violations).toEqual([
      {
        entryId: "demo.entry",
        nodeId: "get-order",
        rule: "non-pinning-assert",
        detail: expect.stringContaining("status"),
      },
    ]);
  });

  it("does not flag an exact `status eq 204` with no body assertion (a 204 DELETE is legitimately status-only)", () => {
    const violations = strictViolations(
      manifestOf([
        {
          id: "delete-order",
          request: { method: "DELETE", url: "https://api.example/orders/1" },
          assert: [{ path: "status", op: "eq", value: 204 }],
        },
      ]),
    );

    expect(violations).toEqual([]);
  });

  it("flags a node with no assertions at all", () => {
    const violations = strictViolations(
      manifestOf([{ id: "ping", request: { method: "GET", url: "https://api.example/ping" } }]),
    );

    expect(violations).toEqual([
      {
        entryId: "demo.entry",
        nodeId: "ping",
        rule: "non-pinning-assert",
        detail: "no assertions — this node cannot fail",
      },
    ]);
  });

  it("does not flag a node whose assertions include an `fn` escape hatch", () => {
    const violations = strictViolations(
      manifestOf([
        {
          id: "login",
          request: { method: "POST", url: "https://api.example/auth/login" },
          assert: [{ path: "status", op: "lt", value: 500 }, { fnHash: "sha256:deadbeef" }],
        },
      ]),
    );

    expect(violations).toEqual([]);
  });
});

describe("strictViolations — unwired chain placeholder", () => {
  // A pinning assertion, so these nodes can only trip the chain rule (not the assert rule).
  const pinned: Assertion[] = [{ path: "status", op: "eq", value: 200 }];

  it("flags the placeholder wherever it survives in the request", () => {
    const violations = strictViolations(
      manifestOf([
        {
          id: "in-url",
          request: { method: "GET", url: "https://api.example/orders/__TODO_CHAIN__" },
          assert: pinned,
        },
        {
          id: "in-header",
          request: {
            method: "GET",
            url: "https://api.example/me",
            headers: { authorization: "Bearer __TODO_CHAIN__" },
          },
          assert: pinned,
        },
        {
          id: "in-query",
          request: {
            method: "GET",
            url: "https://api.example/orders",
            query: { customer: "__TODO_CHAIN__" },
          },
          assert: pinned,
        },
        {
          id: "in-body",
          request: {
            method: "POST",
            url: "https://api.example/refunds",
            body: { order: { id: "__TODO_CHAIN__" } },
          },
          assert: pinned,
        },
      ]),
    );

    expect(violations.map((v) => `${v.nodeId}:${v.rule}`)).toEqual([
      "in-url:unwired-chain",
      "in-header:unwired-chain",
      "in-query:unwired-chain",
      "in-body:unwired-chain",
    ]);
    // The detail names the field, so the author knows where to wire the `{{nodes.X.var}}` ref.
    expect(violations.map((v) => v.detail)).toEqual([
      "unresolved __TODO_CHAIN__ in url",
      "unresolved __TODO_CHAIN__ in headers",
      "unresolved __TODO_CHAIN__ in query",
      "unresolved __TODO_CHAIN__ in body",
    ]);
  });

  it("reports both rules when a scaffolded node is unwired *and* non-pinning", () => {
    const violations = strictViolations(
      manifestOf([
        {
          id: "scaffolded",
          request: { method: "GET", url: "https://api.example/orders/__TODO_CHAIN__" },
          assert: [{ path: "status", op: "lt", value: 500 }],
        },
      ]),
    );

    expect(violations.map((v) => v.rule)).toEqual(["unwired-chain", "non-pinning-assert"]);
  });
});
