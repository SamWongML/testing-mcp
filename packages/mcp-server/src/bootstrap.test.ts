import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compile } from "@atp/compile";
import { loadConfig } from "@atp/schema";
import { describe, expect, it } from "vitest";

import { buildContext } from "./bootstrap";
import { repoRoot } from "./testkit";

describe("buildContext", () => {
  it("compiles the corpus from TESTS_ROOT when no manifest path is set", async () => {
    const ctx = await buildContext(loadConfig({ TESTS_ROOT: repoRoot }));

    expect(ctx.manifest.entries.map((e) => e.id)).toContain("identity.login");
    expect(ctx.sourceRoot).toBe(repoRoot);
    expect(ctx.artifactEnv).toBe("mcp");
    expect(ctx.db).toBeUndefined(); // offline: no db wired, so list_runs reports empty history
  });

  it("loads a prebuilt manifest from MANIFEST_PATH instead of compiling", async () => {
    const built = await compile({ root: repoRoot });
    const dir = await mkdtemp(join(tmpdir(), "atp-manifest-"));
    const path = join(dir, "manifest.json");
    await writeFile(path, JSON.stringify(built));

    const ctx = await buildContext(loadConfig({ MANIFEST_PATH: path, TESTS_ROOT: repoRoot }));

    expect(ctx.manifest.manifestHash).toBe(built.manifestHash);
    expect(ctx.manifest.entries).toHaveLength(built.entries.length);
  });

  it("fails fast when the manifest source is malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atp-manifest-"));
    const path = join(dir, "manifest.json");
    await writeFile(path, JSON.stringify({ not: "a manifest" }));

    await expect(buildContext(loadConfig({ MANIFEST_PATH: path }))).rejects.toThrow();
  });
});
