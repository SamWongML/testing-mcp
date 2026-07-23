import { describe, expect, it } from "vitest";

import { manifestEntrySchema, manifestSchema, SCHEMA_VERSION } from "./manifest";
import { deriveParamsSchema } from "./params";

const loginEntry = {
  id: "identity.login",
  kind: "test" as const,
  version: 1,
  title: "User can log in",
  tags: ["identity", "auth"],
  owner: "team-identity",
  timeoutMs: 15_000,
  paramsSchema: deriveParamsSchema((z) => z.object({ email: z.string().email() })),
  nodes: [
    {
      id: "post-login",
      request: { method: "POST", url: "{{env.baseUrl}}/auth/login" },
      // fn escape-hatch is represented in the manifest by its content hash only.
      assert: [{ path: "status", op: "eq", value: 200 }, { fnHash: "sha256:expiry" }],
    },
  ],
  sourcePath: "tests/identity/login.test.ts",
};

describe("manifestEntrySchema", () => {
  it("parses a normalized entry and defaults isLongRunning to false", () => {
    const parsed = manifestEntrySchema.parse(loginEntry);
    expect(parsed.kind).toBe("test");
    expect(parsed.isLongRunning).toBe(false);
    expect(parsed.paramsSchema?.type).toBe("object");
  });

  it("keeps escape-hatch assertions as fnHash markers (no functions in the manifest)", () => {
    const parsed = manifestEntrySchema.parse(loginEntry);
    expect(parsed.nodes[0]?.assert[1]).toEqual({ fnHash: "sha256:expiry" });
  });

  it("requires a sourcePath", () => {
    const { sourcePath: _omit, ...withoutSource } = loginEntry;
    void _omit;
    expect(() => manifestEntrySchema.parse(withoutSource)).toThrow();
  });
});

describe("manifestSchema", () => {
  it("defaults schemaVersion and carries reproducibility fields", () => {
    const parsed = manifestSchema.parse({
      gitSha: "abc1234",
      manifestHash: "sha256:deadbeef",
      entries: [loginEntry],
    });
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSION);
    expect(parsed.entries).toHaveLength(1);
  });

  it("accepts an empty catalog", () => {
    const parsed = manifestSchema.parse({ gitSha: "s", manifestHash: "h", entries: [] });
    expect(parsed.entries).toEqual([]);
  });

  it("requires gitSha and manifestHash", () => {
    expect(() => manifestSchema.parse({ entries: [] })).toThrow();
  });

  it("rejects duplicate entry ids", () => {
    expect(() =>
      manifestSchema.parse({
        gitSha: "s",
        manifestHash: "h",
        entries: [loginEntry, loginEntry],
      }),
    ).toThrow();
  });
});
