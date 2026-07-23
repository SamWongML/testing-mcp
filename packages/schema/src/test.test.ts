import { describe, expect, it } from "vitest";

import {
  assertionSchema,
  matrixSchema,
  requestSchema,
  retryPolicySchema,
  stepSchema,
  testCaseSchema,
} from "./test";

describe("requestSchema", () => {
  it("accepts a minimal request", () => {
    const parsed = requestSchema.parse({
      method: "POST",
      url: "{{env.baseUrl}}/auth/login",
    });
    expect(parsed.method).toBe("POST");
    expect(parsed.headers).toBeUndefined();
  });

  it("rejects an unknown HTTP method", () => {
    expect(() => requestSchema.parse({ method: "FETCH", url: "/x" })).toThrow();
  });
});

describe("assertionSchema", () => {
  it("accepts a declarative assertion", () => {
    const parsed = assertionSchema.parse({ path: "status", op: "eq", value: 200 });
    expect(parsed).toEqual({ path: "status", op: "eq", value: 200 });
  });

  it("accepts a value-less operator", () => {
    const parsed = assertionSchema.parse({ path: "body.token", op: "isString" });
    expect(parsed).toMatchObject({ op: "isString" });
  });

  it("accepts a normalized fn marker (escape hatch)", () => {
    const parsed = assertionSchema.parse({ fnHash: "sha256:abc", message: "must be positive" });
    expect(parsed).toMatchObject({ fnHash: "sha256:abc" });
  });

  it("rejects an assertion that is neither declarative nor an fn marker", () => {
    expect(() => assertionSchema.parse({ message: "nope" })).toThrow();
  });
});

describe("retryPolicySchema", () => {
  it("defaults backoffMs and on-list", () => {
    const parsed = retryPolicySchema.parse({ max: 2 });
    expect(parsed).toEqual({ max: 2, backoffMs: 0, on: [] });
  });

  it("rejects an unknown retry trigger", () => {
    expect(() => retryPolicySchema.parse({ max: 1, on: ["3xx"] })).toThrow();
  });
});

describe("stepSchema", () => {
  it("applies defaults for assert/extract/needs", () => {
    const parsed = stepSchema.parse({
      id: "post-login",
      request: { method: "POST", url: "/auth/login" },
    });
    expect(parsed.assert).toEqual([]);
    expect(parsed.extract).toEqual([]);
    expect(parsed.needs).toEqual([]);
  });

  it("accepts poll and retry policies", () => {
    const parsed = stepSchema.parse({
      id: "verify",
      request: { method: "GET", url: "/ledger" },
      retry: { max: 3, backoffMs: 500, on: ["5xx"] },
      poll: { untilAssertPasses: true, intervalMs: 3000, maxMs: 90_000 },
    });
    expect(parsed.poll?.intervalMs).toBe(3000);
    expect(parsed.retry?.max).toBe(3);
  });
});

describe("matrixSchema", () => {
  it("accepts a cartesian matrix definition", () => {
    const parsed = matrixSchema.parse({ region: ["us", "eu", "ap"], tier: ["free", "pro"] });
    expect(parsed.region).toHaveLength(3);
  });

  it("rejects an empty matrix dimension", () => {
    expect(() => matrixSchema.parse({ region: [] })).toThrow();
  });
});

describe("testCaseSchema", () => {
  it("parses the §7.1 login test (normalized)", () => {
    const parsed = testCaseSchema.parse({
      id: "identity.login",
      version: 1,
      title: "User can log in and receive a token",
      tags: ["identity", "auth", "smoke"],
      owner: "team-identity",
      timeoutMs: 15_000,
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
            { fnHash: "sha256:expiry" },
          ],
          extract: [{ as: "authToken", from: "body.token" }],
          retry: { max: 2, backoffMs: 500, on: ["network", "5xx"] },
        },
      ],
    });
    expect(parsed.id).toBe("identity.login");
    expect(parsed.steps[0]?.assert).toHaveLength(3);
    expect(parsed.tags).toEqual(["identity", "auth", "smoke"]);
  });

  it("requires at least one step", () => {
    expect(() => testCaseSchema.parse({ id: "x", version: 1, steps: [] })).toThrow();
  });

  it("rejects duplicate step ids", () => {
    expect(() =>
      testCaseSchema.parse({
        id: "x",
        version: 1,
        steps: [
          { id: "s", request: { method: "GET", url: "/a" } },
          { id: "s", request: { method: "GET", url: "/b" } },
        ],
      }),
    ).toThrow();
  });

  it("rejects a non-positive version", () => {
    expect(() =>
      testCaseSchema.parse({
        id: "x",
        version: 0,
        steps: [{ id: "s", request: { method: "GET", url: "/" } }],
      }),
    ).toThrow();
  });
});
