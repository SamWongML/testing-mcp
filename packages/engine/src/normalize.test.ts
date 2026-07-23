import { manifestEntrySchema } from "@atp/schema";
import { describe, expect, it } from "vitest";

import { defineSuite, defineTest, useStep, useTest } from "./define";
import { hashFn } from "./fnHash";
import { normalize } from "./normalize";

const expiresPredicate = (res: unknown) => (res as { body: { expiresIn: number } }).body.expiresIn > 0;

const login = defineTest({
  id: "identity.login",
  version: 1,
  title: "User can log in",
  tags: ["identity", "auth"],
  owner: "team-identity",
  timeoutMs: 15_000,
  env: { baseUrl: "https://example.com" },
  params: (z) => z.object({ email: z.string().email().default("qa@example.com") }),
  steps: [
    {
      id: "post-login",
      request: {
        method: "POST",
        url: "{{env.baseUrl}}/auth/login",
        body: { email: "{{params.email}}" },
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { fn: expiresPredicate, message: "not expired" },
      ],
      extract: [{ as: "authToken", from: "body.token" }],
    },
  ],
});

describe("normalize (test)", () => {
  it("normalizes a single test into one manifest entry", () => {
    const [entry, ...rest] = normalize(login, "tests/identity/login.test.ts");
    expect(rest).toHaveLength(0);
    expect(entry?.id).toBe("identity.login");
    expect(entry?.kind).toBe("test");
    expect(entry?.version).toBe(1);
    expect(entry?.title).toBe("User can log in");
    expect(entry?.tags).toEqual(["identity", "auth"]);
    expect(entry?.owner).toBe("team-identity");
    expect(entry?.timeoutMs).toBe(15_000);
    expect(entry?.sourcePath).toBe("tests/identity/login.test.ts");
    expect(entry?.nodes).toHaveLength(1);
    expect(entry?.nodes[0]?.needs).toEqual([]);
    expect(entry?.nodes[0]?.extract).toEqual([{ as: "authToken", from: "body.token" }]);
  });

  it("replaces fn assertions with their content hash and no function", () => {
    const [entry] = normalize(login, "tests/identity/login.test.ts");
    const assertions = entry?.nodes[0]?.assert ?? [];
    expect(assertions[0]).toEqual({ path: "status", op: "eq", value: 200 });
    expect(assertions[1]).toEqual({
      fnHash: hashFn(expiresPredicate),
      message: "not expired",
    });
    expect(JSON.stringify(entry)).not.toContain("expiresIn");
  });

  it("derives paramsSchema from the authored params builder (defaults are optional)", () => {
    const [entry] = normalize(login, "tests/identity/login.test.ts");
    expect(entry?.paramsSchema?.type).toBe("object");
    expect((entry?.paramsSchema?.properties as Record<string, unknown>)?.email).toBeDefined();
    // A param with a `.default()` is optional in the input schema.
    expect(entry?.paramsSchema?.required).toBeUndefined();
  });

  it("bakes the resolved static env into the entry", () => {
    const [entry] = normalize(login, "tests/identity/login.test.ts");
    expect(entry?.env).toEqual({ baseUrl: "https://example.com" });
  });

  it("produces an entry that validates against manifestEntrySchema", () => {
    const [entry] = normalize(login, "tests/identity/login.test.ts");
    expect(() => manifestEntrySchema.parse(entry)).not.toThrow();
  });

  it("passes node retry/timeoutMs + a declarative message through, keeping {{secrets.*}} literal", () => {
    const def = defineTest({
      id: "t",
      version: 1,
      env: { token: "{{secrets.API_TOKEN}}" },
      steps: [
        {
          id: "s",
          request: { method: "GET", url: "u" },
          assert: [{ path: "status", op: "eq", value: 200, message: "must be ok" }],
          retry: { max: 2, backoffMs: 100, on: ["5xx"] },
          timeoutMs: 5_000,
        },
      ],
    });
    const [entry] = normalize(def, "f.test.ts");
    expect(entry?.nodes[0]?.retry).toEqual({ max: 2, backoffMs: 100, on: ["5xx"] });
    expect(entry?.nodes[0]?.timeoutMs).toBe(5_000);
    expect(entry?.nodes[0]?.assert[0]).toEqual({
      path: "status",
      op: "eq",
      value: 200,
      message: "must be ok",
    });
    // Secrets stay literal in the manifest — they resolve in the engine at run time.
    expect(entry?.env).toEqual({ token: "{{secrets.API_TOKEN}}" });
  });
});

describe("normalize (isLongRunning)", () => {
  const base = {
    id: "t",
    version: 1,
    steps: [{ id: "s", request: { method: "GET" as const, url: "u" }, assert: [] }],
  };

  it("infers false for a short timeout", () => {
    const [entry] = normalize(defineTest({ ...base, timeoutMs: 15_000 }), "f.test.ts");
    expect(entry?.isLongRunning).toBe(false);
  });

  it("infers true for a long timeout", () => {
    const [entry] = normalize(defineTest({ ...base, timeoutMs: 120_000 }), "f.test.ts");
    expect(entry?.isLongRunning).toBe(true);
  });

  it("honors an explicit isLongRunning over the inference", () => {
    const [entry] = normalize(
      defineTest({ ...base, timeoutMs: 120_000, isLongRunning: false }),
      "f.test.ts",
    );
    expect(entry?.isLongRunning).toBe(false);
  });
});

describe("normalize (matrix)", () => {
  const matrixed = defineTest({
    id: "identity.login.matrix",
    version: 1,
    matrix: { region: ["us", "eu"], tier: ["free", "pro"] },
    env: (m) => ({ baseUrl: `https://${m.region as string}.example.com` }),
    steps: [{ id: "s", request: { method: "GET" as const, url: "{{env.baseUrl}}/x" }, assert: [] }],
  });

  it("expands one entry per cartesian cell with per-cell ids", () => {
    const entries = normalize(matrixed, "f.test.ts");
    expect(entries.map((e) => e.id)).toEqual([
      "identity.login.matrix#region=us,tier=free",
      "identity.login.matrix#region=us,tier=pro",
      "identity.login.matrix#region=eu,tier=free",
      "identity.login.matrix#region=eu,tier=pro",
    ]);
  });

  it("resolves the env builder per cell and records the cell coords", () => {
    const entries = normalize(matrixed, "f.test.ts");
    const eu = entries.find((e) => e.id.includes("region=eu"));
    expect(eu?.env).toEqual({ baseUrl: "https://eu.example.com" });
    // The cell's coordinates are recorded as a singleton matrix (schema-valid).
    expect(eu?.matrix).toEqual({ region: ["eu"], tier: expect.any(Array) });
  });

  it("rejects an empty matrix dimension at compile time (no silent zero-unit expansion)", () => {
    const empty = defineTest({
      id: "t",
      version: 1,
      matrix: { region: [] },
      steps: [{ id: "s", request: { method: "GET" as const, url: "u" }, assert: [] }],
    });
    expect(() => normalize(empty, "f.test.ts")).toThrow();
  });
});

describe("normalize (suite)", () => {
  const suite = defineSuite({
    id: "billing.flow",
    version: 2,
    title: "flow",
    tags: ["billing"],
    timeoutMs: 120_000,
    nodes: {
      auth: useTest(login, { params: { email: "bot@example.com" } }),
      charge: {
        needs: ["auth"],
        request: { method: "POST", url: "{{env.baseUrl}}/charge" },
        assert: [{ path: "status", op: "eq", value: 200 }],
      },
    },
  });

  it("normalizes a suite into one entry with topo-ordered nodes and needs edges", () => {
    const [entry, ...rest] = normalize(suite, "tests/billing/flow.suite.ts");
    expect(rest).toHaveLength(0);
    expect(entry?.kind).toBe("suite");
    expect(entry?.nodes.map((n) => n.id)).toEqual(["auth", "charge"]);
    expect(entry?.nodes[1]?.needs).toEqual(["auth"]);
    expect(entry?.isLongRunning).toBe(true);
  });

  it("rejects a cyclic suite at compile time", () => {
    const cyclic = defineSuite({
      id: "cyclic",
      version: 1,
      nodes: {
        a: { needs: ["b"], request: { method: "GET", url: "u" } },
        b: { needs: ["a"], request: { method: "GET", url: "u" } },
      },
    });
    expect(() => normalize(cyclic, "f.suite.ts")).toThrow();
  });

  it("normalizes a useStep node into a valid request node keyed by the map id", () => {
    const createOrder = {
      id: "create-order",
      request: { method: "POST" as const, url: "{{env.baseUrl}}/orders" },
      assert: [{ path: "status", op: "eq" as const, value: 201 }],
    };
    const withStep = defineSuite({
      id: "billing.order",
      version: 1,
      nodes: { order: useStep(createOrder, { with: { token: "{{nodes.auth.authToken}}" } }) },
    });
    const [entry] = normalize(withStep, "f.suite.ts");
    expect(entry?.nodes[0]?.id).toBe("order");
    expect(entry?.nodes[0]?.request.url).toBe("{{env.baseUrl}}/orders");
  });

  it("expands a matrixed suite into one suite entry per cell with per-cell env", () => {
    const regional = defineSuite({
      id: "billing.regional",
      version: 1,
      matrix: { region: ["us", "eu"] },
      env: (m) => ({ baseUrl: `https://${m.region as string}.example.com` }),
      nodes: {
        charge: {
          request: { method: "POST", url: "{{env.baseUrl}}/charge" },
          assert: [{ path: "status", op: "eq", value: 200 }],
        },
      },
    });
    const entries = normalize(regional, "f.suite.ts");
    expect(entries.map((e) => e.id)).toEqual([
      "billing.regional#region=us",
      "billing.regional#region=eu",
    ]);
    expect(entries.every((e) => e.kind === "suite")).toBe(true);
    expect(entries[0]?.env).toEqual({ baseUrl: "https://us.example.com" });
    expect(entries[1]?.env).toEqual({ baseUrl: "https://eu.example.com" });
    expect(entries[0]?.nodes.map((n) => n.id)).toEqual(["charge"]);
  });
});

describe("normalize (compile-time guards)", () => {
  it("rejects a non-positive poll.intervalMs at compile time", () => {
    const bad = defineTest({
      id: "t",
      version: 1,
      steps: [
        {
          id: "s",
          request: { method: "GET", url: "u" },
          assert: [],
          poll: { untilAssertPasses: true, intervalMs: 0, maxMs: 1_000 },
        },
      ],
    });
    expect(() => normalize(bad, "f.test.ts")).toThrow();
  });
});
