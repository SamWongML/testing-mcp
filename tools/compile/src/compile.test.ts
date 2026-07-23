import { resolve } from "node:path";

import { manifestSchema, type ManifestEntry } from "@atp/schema";
import { describe, expect, it } from "vitest";

import { compile, manifestHash } from "./compile";

const fixturesRoot = resolve(__dirname, "../fixtures");

function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    id: "x",
    kind: "test",
    version: 1,
    tags: [],
    isLongRunning: false,
    nodes: [{ id: "s", request: { method: "GET", url: "u" }, assert: [], extract: [], needs: [] }],
    sourcePath: "tests/x.test.ts",
    ...overrides,
  };
}

describe("manifestHash", () => {
  it("is deterministic for the same entries", () => {
    const a = manifestHash([entry({ id: "a" }), entry({ id: "b" })]);
    const b = manifestHash([entry({ id: "a" }), entry({ id: "b" })]);
    expect(a).toBe(b);
  });

  it("is stable regardless of entry order (sorted before hashing)", () => {
    const a = manifestHash([entry({ id: "a" }), entry({ id: "b" })]);
    const b = manifestHash([entry({ id: "b" }), entry({ id: "a" })]);
    expect(a).toBe(b);
  });

  it("changes when entry content changes", () => {
    const a = manifestHash([entry({ id: "a", version: 1 })]);
    const b = manifestHash([entry({ id: "a", version: 2 })]);
    expect(a).not.toBe(b);
  });
});

describe("compile", () => {
  it("discovers, normalizes, and emits a valid manifest", async () => {
    const manifest = await compile({ root: fixturesRoot, testsDir: "ok", gitSha: "abc123" });
    expect(() => manifestSchema.parse(manifest)).not.toThrow();
    expect(manifest.schemaVersion).toBe("1.0");
    expect(manifest.gitSha).toBe("abc123");
    expect(manifest.manifestHash).toMatch(/^sha256:/);
    expect(manifest.entries.map((e) => e.id)).toEqual(["fix.alpha", "fix.beta"]);
  });

  it("records the repo-relative sourcePath per entry", async () => {
    const manifest = await compile({ root: fixturesRoot, testsDir: "ok", gitSha: "abc123" });
    const alpha = manifest.entries.find((e) => e.id === "fix.alpha");
    expect(alpha?.sourcePath).toBe("ok/alpha.test.ts");
  });

  it("sorts entries by id for a deterministic manifest", async () => {
    const manifest = await compile({ root: fixturesRoot, testsDir: "ok", gitSha: "abc123" });
    const ids = manifest.entries.map((e) => e.id);
    expect(ids).toEqual([...ids].sort());
  });

  it("throws a friendly error naming the offending file and reason", async () => {
    await expect(
      compile({ root: fixturesRoot, testsDir: "broken", gitSha: "abc123" }),
    ).rejects.toThrow(/cyclic\.suite\.ts/);
  });
});
