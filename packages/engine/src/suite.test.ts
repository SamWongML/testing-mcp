import type { AuthoredStep, AuthoredTestCase } from "@atp/schema";
import { describe, expect, it } from "vitest";

import { defineSuite, useStep, useTest } from "./define";
import { planSuite } from "./suite";

const login: AuthoredTestCase = {
  id: "identity.login",
  version: 1,
  params: (z) => z.object({ email: z.string(), tier: z.string().default("free") }),
  steps: [
    {
      id: "post",
      request: {
        method: "POST",
        url: "{{env.baseUrl}}/login",
        body: { email: "{{params.email}}", tier: "{{params.tier}}" },
      },
      extract: [{ as: "authToken", from: "body.token" }],
    },
  ],
};

const createOrder: AuthoredStep = {
  id: "create-order",
  request: {
    method: "POST",
    url: "{{env.baseUrl}}/orders",
    headers: { authorization: "Bearer {{params.token}}" },
  },
  extract: [{ as: "paymentId", from: "body.paymentId" }],
};

describe("useTest / useStep", () => {
  it("useTest embeds the test by reference with param overrides", () => {
    const node = useTest(login, { params: { email: "bot@example.com" }, needs: ["x"] });
    expect(node).toEqual({
      use: "test",
      test: login,
      params: { email: "bot@example.com" },
      needs: ["x"],
    });
  });

  it("useStep embeds the step by reference with bound inputs", () => {
    const node = useStep(createOrder, { with: { token: "{{nodes.auth.authToken}}" } });
    expect(node).toEqual({
      use: "step",
      step: createOrder,
      with: { token: "{{nodes.auth.authToken}}" },
      needs: undefined,
    });
  });
});

describe("planSuite", () => {
  it("flattens inline nodes, keying the id off the map and carrying needs", () => {
    const suite = defineSuite({
      id: "s",
      version: 1,
      nodes: {
        first: { request: { method: "GET", url: "/a" } },
        second: { needs: ["first"], request: { method: "GET", url: "/b" } },
      },
    });
    const plan = planSuite(suite);
    expect(plan.map((n) => n.id)).toEqual(["first", "second"]);
    expect(plan[1]?.needs).toEqual(["first"]);
    expect(plan[0]?.step.request.url).toBe("/a");
    expect(plan[0]?.params).toEqual({});
  });

  it("inlines a useStep node, exposing `with` as the node's params", () => {
    const suite = defineSuite({
      id: "s",
      version: 1,
      nodes: {
        order: useStep(createOrder, { with: { token: "abc" } }),
      },
    });
    const [node] = planSuite(suite);
    expect(node?.id).toBe("order");
    expect(node?.step.request.url).toBe("{{env.baseUrl}}/orders");
    expect(node?.params).toEqual({ token: "abc" });
  });

  it("inlines a useTest node, resolving params (defaults applied) and re-keying the step id", () => {
    const suite = defineSuite({
      id: "s",
      version: 1,
      nodes: {
        auth: useTest(login, { params: { email: "bot@example.com" } }),
      },
    });
    const [node] = planSuite(suite);
    expect(node?.id).toBe("auth");
    expect(node?.step.id).toBe("auth");
    expect(node?.params).toEqual({ email: "bot@example.com", tier: "free" });
  });

  it("returns nodes in topological order (dependencies first)", () => {
    const suite = defineSuite({
      id: "s",
      version: 1,
      nodes: {
        verify: { needs: ["refund"], request: { method: "GET", url: "/v" } },
        refund: { needs: ["auth"], request: { method: "POST", url: "/r" } },
        auth: useTest(login, { params: { email: "bot@example.com" } }),
      },
    });
    const ids = planSuite(suite).map((n) => n.id);
    expect(ids.indexOf("auth")).toBeLessThan(ids.indexOf("refund"));
    expect(ids.indexOf("refund")).toBeLessThan(ids.indexOf("verify"));
  });

  it("rejects a cyclic suite (delegates to graph validation)", () => {
    const suite = defineSuite({
      id: "s",
      version: 1,
      nodes: {
        a: { needs: ["b"], request: { method: "GET", url: "/a" } },
        b: { needs: ["a"], request: { method: "GET", url: "/b" } },
      },
    });
    expect(() => planSuite(suite)).toThrow(/cycle/i);
  });

  it("rejects composing a multi-step test via useTest (unsupported for now)", () => {
    const multi: AuthoredTestCase = {
      id: "multi",
      version: 1,
      steps: [
        { id: "one", request: { method: "GET", url: "/1" } },
        { id: "two", request: { method: "GET", url: "/2" } },
      ],
    };
    const suite = defineSuite({
      id: "s",
      version: 1,
      nodes: { m: useTest(multi) },
    });
    expect(() => planSuite(suite)).toThrow(/single-step/i);
  });
});

describe("defineSuite", () => {
  it("requires at least one node", () => {
    expect(() => defineSuite({ id: "s", version: 1, nodes: {} })).toThrow(/node/i);
  });

  it("requires a positive integer version", () => {
    expect(() =>
      defineSuite({
        id: "s",
        version: 0,
        nodes: { a: { request: { method: "GET", url: "/a" } } },
      }),
    ).toThrow(/version/i);
  });
});
