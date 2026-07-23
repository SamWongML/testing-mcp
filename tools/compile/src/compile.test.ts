import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { manifestSchema, type ManifestEntry } from "@atp/schema";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { compile, compileToFile, manifestHash, resolveGitSha, writeManifest } from "./compile";

const fixturesRoot = resolve(__dirname, "../fixtures");
const repoRoot = resolve(__dirname, "../../..");

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

  it("throws a friendly error for a discovered file with no default export", async () => {
    await expect(
      compile({ root: fixturesRoot, testsDir: "nodefault", gitSha: "abc123" }),
    ).rejects.toThrow(/notdefault\.test\.ts: no default export/);
  });
});

describe("resolveGitSha", () => {
  const savedSha = process.env.GITHUB_SHA;
  afterEach(() => {
    if (savedSha === undefined) delete process.env.GITHUB_SHA;
    else process.env.GITHUB_SHA = savedSha;
  });

  it("prefers $GITHUB_SHA when set", () => {
    process.env.GITHUB_SHA = "ci-provided-sha";
    expect(resolveGitSha(repoRoot)).toBe("ci-provided-sha");
  });

  it("falls back to `git rev-parse HEAD` inside a repo", () => {
    delete process.env.GITHUB_SHA;
    expect(resolveGitSha(repoRoot)).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('falls back to "unknown" outside a git repo', () => {
    delete process.env.GITHUB_SHA;
    const nonGit = mkdtempSync(join(tmpdir(), "atp-nogit-"));
    try {
      expect(resolveGitSha(nonGit)).toBe("unknown");
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe("writeManifest / compileToFile", () => {
  const outDir = mkdtempSync(join(tmpdir(), "atp-out-"));
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it("writes pretty JSON with a trailing newline", async () => {
    const manifest = await compile({ root: fixturesRoot, testsDir: "ok", gitSha: "abc123" });
    const out = join(outDir, "manifest.json");
    await writeManifest(manifest, out);
    const text = readFileSync(out, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).entries).toHaveLength(2);
  });

  it("compileToFile compiles and writes dist/manifest.json under the root", async () => {
    const root = mkdtempSync(join(tmpdir(), "atp-root-"));
    // Nothing to discover (no tests/ dir) → an empty, valid manifest written to disk.
    try {
      const { manifest, outPath } = await compileToFile(root);
      expect(outPath).toBe(join(root, "dist/manifest.json"));
      expect(manifest.entries).toEqual([]);
      expect(JSON.parse(readFileSync(outPath, "utf8")).schemaVersion).toBe("1.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
