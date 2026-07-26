import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { compile } from "@atp/compile";
import { loadConfig } from "@atp/schema";
import { describe, expect, it } from "vitest";

import { buildAuthContext, buildContext } from "./bootstrap";
import { fixtureRoot, repoRoot } from "./testkit";

describe("buildContext", () => {
  it("compiles the corpus from TESTS_ROOT when no manifest path is set", async () => {
    const ctx = await buildContext(loadConfig({ TESTS_ROOT: fixtureRoot }));

    expect(ctx.manifest.entries.map((e) => e.id)).toContain("alpha.create-widget");
    expect(ctx.sourceRoot).toBe(fixtureRoot);
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

  it("wires no auth context by default (dev-off), so the surface is unauthenticated", async () => {
    const ctx = await buildContext(loadConfig({ TESTS_ROOT: repoRoot }));
    expect(ctx.authn).toBeUndefined();
  });
});

describe("buildAuthContext", () => {
  it("returns undefined when auth is disabled (the default)", () => {
    expect(buildAuthContext(loadConfig({}))).toBeUndefined();
  });

  it("builds an auth context from the issuer/resource/jwks config when enabled", () => {
    const ac = buildAuthContext(
      loadConfig({
        AUTH_ENABLED: "true",
        AUTH_ISSUER: "https://auth.example.com",
        AUTH_RESOURCE: "https://atp.example.com/mcp",
        AUTH_JWKS_URI: "https://auth.example.com/jwks.json",
      }),
    );
    expect(ac?.issuer).toBe("https://auth.example.com");
    expect(ac?.resource).toBe("https://atp.example.com/mcp");
    expect(typeof ac?.authenticator.verify).toBe("function");
  });

  it("fails fast when auth is enabled without issuer/resource/jwks", () => {
    expect(() => buildAuthContext(loadConfig({ AUTH_ENABLED: "true" }))).toThrow();
  });
});
