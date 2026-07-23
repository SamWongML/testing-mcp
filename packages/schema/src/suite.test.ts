import { describe, expect, it } from "vitest";

import { suiteNodeSchema, suiteSchema } from "./suite";

describe("suiteNodeSchema", () => {
  it("is a step carrying explicit `needs` edges", () => {
    const parsed = suiteNodeSchema.parse({
      id: "capture",
      needs: ["order"],
      request: {
        method: "POST",
        url: "{{env.baseUrl}}/payments/{{nodes.order.paymentId}}/capture",
      },
      assert: [{ path: "status", op: "eq", value: 200 }],
    });
    expect(parsed.needs).toEqual(["order"]);
  });

  it("defaults needs to an empty array (a root node)", () => {
    const parsed = suiteNodeSchema.parse({
      id: "auth",
      request: { method: "POST", url: "/auth/login" },
    });
    expect(parsed.needs).toEqual([]);
  });
});

describe("suiteSchema", () => {
  it("parses the §7.2 refund suite (normalized nodes)", () => {
    const parsed = suiteSchema.parse({
      id: "billing.e2e-refund",
      version: 3,
      title: "Create order → capture → refund → verify ledger",
      tags: ["billing", "e2e"],
      owner: "team-billing",
      timeoutMs: 120_000,
      nodes: [
        { id: "auth", request: { method: "POST", url: "/auth/login" } },
        {
          id: "order",
          needs: ["auth"],
          request: { method: "POST", url: "/orders" },
          extract: [{ as: "paymentId", from: "body.paymentId" }],
        },
        {
          id: "verify",
          needs: ["refund"],
          request: { method: "GET", url: "/ledger" },
          assert: [{ path: "body.status", op: "eq", value: "settled" }],
          poll: { untilAssertPasses: true, intervalMs: 3000, maxMs: 90_000 },
        },
      ],
    });
    expect(parsed.nodes).toHaveLength(3);
    expect(parsed.nodes[1]?.needs).toEqual(["auth"]);
  });

  it("requires at least one node", () => {
    expect(() => suiteSchema.parse({ id: "x", version: 1, nodes: [] })).toThrow();
  });
});
