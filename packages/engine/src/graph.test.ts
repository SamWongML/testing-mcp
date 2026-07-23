import { describe, expect, it } from "vitest";

import { topoSort } from "./graph";

describe("topoSort", () => {
  it("keeps independent nodes in authored order", () => {
    expect(
      topoSort([
        { id: "a", needs: [] },
        { id: "b", needs: [] },
      ]),
    ).toEqual(["a", "b"]);
  });

  it("places every dependency before its dependents", () => {
    const order = topoSort([
      { id: "verify", needs: ["refund"] },
      { id: "refund", needs: ["auth"] },
      { id: "auth", needs: [] },
    ]);
    expect(order.indexOf("auth")).toBeLessThan(order.indexOf("refund"));
    expect(order.indexOf("refund")).toBeLessThan(order.indexOf("verify"));
  });

  it("resolves a diamond DAG (both branches before the join)", () => {
    const order = topoSort([
      { id: "a", needs: [] },
      { id: "b", needs: ["a"] },
      { id: "c", needs: ["a"] },
      { id: "d", needs: ["b", "c"] },
    ]);
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("b"));
    expect(order.indexOf("a")).toBeLessThan(order.indexOf("c"));
    expect(order.indexOf("b")).toBeLessThan(order.indexOf("d"));
    expect(order.indexOf("c")).toBeLessThan(order.indexOf("d"));
  });

  it("treats a missing `needs` array as no dependencies", () => {
    expect(topoSort([{ id: "solo" }])).toEqual(["solo"]);
  });

  it("throws on a cycle, naming the involved nodes", () => {
    expect(() =>
      topoSort([
        { id: "a", needs: ["b"] },
        { id: "b", needs: ["a"] },
      ]),
    ).toThrow(/cycle.*a.*b|cycle.*b.*a/i);
  });

  it("throws when a `needs` edge references an unknown node", () => {
    expect(() => topoSort([{ id: "a", needs: ["ghost"] }])).toThrow(/ghost/);
  });

  it("throws on duplicate node ids", () => {
    expect(() =>
      topoSort([
        { id: "a", needs: [] },
        { id: "a", needs: [] },
      ]),
    ).toThrow(/duplicate.*a/i);
  });
});
