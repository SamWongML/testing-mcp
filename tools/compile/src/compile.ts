import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { normalize } from "@atp/engine";
import {
  manifestSchema,
  SCHEMA_VERSION,
  type AuthoredSuite,
  type AuthoredTestCase,
  type Manifest,
  type ManifestEntry,
} from "@atp/schema";

import { discover } from "./discover";

/**
 * The compile step (research §9, §7.4, ADR-003): discover authored test/suite files,
 * import each, `normalize()` it into serializable manifest entries, and emit a single
 * validated `dist/manifest.json` stamped with `gitSha` + `manifestHash`. The manifest is
 * the catalog the MCP server loads — pure JSON, no functions. Adding a test is dropping a
 * conforming file; re-running compile surfaces it with zero registration.
 */

export interface CompileOptions {
  /** Repo root; `sourcePath`s are recorded relative to it. Defaults to `process.cwd()`. */
  root?: string;
  /** Directory under `root` to scan for the corpus. Defaults to `"tests"`. */
  testsDir?: string;
  /** Override the recorded git sha (else `$GITHUB_SHA`, then `git rev-parse HEAD`). */
  gitSha?: string;
}

/** One file that failed to import or normalize, paired with its reason. */
export interface CompileFailure {
  file: string;
  message: string;
}

/** Aggregated compile failure: every offending file is named with its reason so an
 *  author can fix all of them in one pass rather than one recompile at a time. */
export class CompileError extends Error {
  constructor(readonly failures: CompileFailure[]) {
    super(
      `compile failed for ${failures.length} file(s):\n` +
        failures.map((f) => `  ${f.file}: ${f.message}`).join("\n"),
    );
    this.name = "CompileError";
  }
}

const byId = (a: ManifestEntry, b: ManifestEntry): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Recursively strip `undefined` and sort object keys so a manifest's hash depends only
 *  on content, not on incidental key ordering from the authored source. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonical(v);
    }
    return out;
  }
  return value;
}

/** A content hash over the entries (order-independent) — runs record it so a result can
 *  be traced back to the exact catalog it ran against (research §21). */
export function manifestHash(entries: ManifestEntry[]): string {
  const sorted = [...entries].sort(byId);
  const digest = createHash("sha256")
    .update(JSON.stringify(canonical(sorted)))
    .digest("hex");
  return `sha256:${digest}`;
}

/** The git sha stamped onto the manifest: `$GITHUB_SHA` (CI) → `git rev-parse HEAD` →
 *  `"unknown"` (e.g. a non-git checkout). An explicit `opts.gitSha` overrides all three. */
export function resolveGitSha(root: string): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

/** Import an authored test/suite module and return its default export (the
 *  `defineTest`/`defineSuite` value). Shared with the CLI's `run`, which loads a def's
 *  source to execute it. The bare message is deliberate — `compile` prefixes the file. */
export async function importDef(file: string): Promise<AuthoredTestCase | AuthoredSuite> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  if (!mod.default || typeof mod.default !== "object") {
    throw new Error("no default export (expected a defineTest/defineSuite value)");
  }
  return mod.default as AuthoredTestCase | AuthoredSuite;
}

/** Discover → import → normalize → validate the corpus into a single manifest. Per-file
 *  import/normalize errors are collected and thrown together as a `CompileError`. */
export async function compile(opts: CompileOptions = {}): Promise<Manifest> {
  const root = opts.root ?? process.cwd();
  const scanDir = resolve(root, opts.testsDir ?? "tests");
  const files = await discover(scanDir);

  const entries: ManifestEntry[] = [];
  const failures: CompileFailure[] = [];
  for (const file of files) {
    const rel = relative(root, file);
    try {
      const def = await importDef(file);
      entries.push(...normalize(def, rel));
    } catch (err) {
      failures.push({ file: rel, message: err instanceof Error ? err.message : String(err) });
    }
  }
  if (failures.length > 0) throw new CompileError(failures);

  entries.sort(byId);
  return manifestSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    gitSha: opts.gitSha ?? resolveGitSha(root),
    manifestHash: manifestHash(entries),
    entries,
  });
}

/** Write a manifest to disk as pretty JSON (creating parent dirs as needed). */
export async function writeManifest(manifest: Manifest, outPath: string): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Compile the corpus and write `dist/manifest.json` under `root`. Returns the manifest
 *  and the path written — the one operation both `pnpm compile` and `atp compile` share. */
export async function compileToFile(
  root: string,
): Promise<{ manifest: Manifest; outPath: string }> {
  const outPath = resolve(root, "dist/manifest.json");
  const manifest = await compile({ root });
  await writeManifest(manifest, outPath);
  return { manifest, outPath };
}
