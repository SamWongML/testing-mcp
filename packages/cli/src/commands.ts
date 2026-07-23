import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { compile } from "@atp/compile";
import {
  resolveEnv,
  runSuite,
  runTest,
  type RunOptionsBase,
  type RunTestOptions,
} from "@atp/engine";
import type {
  AuthoredSuite,
  AuthoredTestCase,
  ExecutionResult,
  ManifestEntry,
  StepStatus,
} from "@atp/schema";

import { startMockSut, type MockSut } from "./mock-sut";

/**
 * The `atp` CLI's command layer (research §P4). `list`/`validate` are thin views over an
 * in-memory `compile()` (always fresh — no stale `dist/manifest.json`). `run` locates an
 * entry's source by id, imports the authored definition (which carries the real functions
 * the manifest strips), and executes it in-process via the engine against the local mock
 * SUT, so the inner loop works fully offline.
 */

function isSuite(def: AuthoredTestCase | AuthoredSuite): def is AuthoredSuite {
  return "nodes" in def;
}

async function importDefault(file: string): Promise<AuthoredTestCase | AuthoredSuite> {
  const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  if (!mod.default || typeof mod.default !== "object") {
    throw new Error(`${file}: no default export (expected a defineTest/defineSuite value)`);
  }
  return mod.default as AuthoredTestCase | AuthoredSuite;
}

/** A matrix-cell id (`base#region=us,tier=free`) carries its coordinates in the suffix;
 *  a plain id has none. Coordinates repopulate `{{matrix.*}}` and select the cell env. */
function cellCoords(id: string): Record<string, unknown> {
  const hash = id.indexOf("#");
  if (hash < 0) return {};
  const coords: Record<string, unknown> = {};
  for (const pair of id.slice(hash + 1).split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) coords[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return coords;
}

export interface ListOptions {
  root?: string;
  tags?: string[];
  owner?: string;
  kind?: "test" | "suite";
}

/** Compile the corpus in-memory and return the entries matching the given filters. */
export async function listEntries(opts: ListOptions = {}): Promise<ManifestEntry[]> {
  const manifest = await compile({ root: opts.root ?? process.cwd() });
  return manifest.entries.filter(
    (e) =>
      (!opts.kind || e.kind === opts.kind) &&
      (!opts.owner || e.owner === opts.owner) &&
      (!opts.tags || opts.tags.every((t) => e.tags.includes(t))),
  );
}

/** Compile the corpus and report how many entries it produced (throws on failure). */
export async function validate(root: string = process.cwd()): Promise<{ entries: number }> {
  const manifest = await compile({ root });
  return { entries: manifest.entries.length };
}

export interface RunOptions {
  root?: string;
  params?: Record<string, unknown>;
  envName?: string;
}

/**
 * Run a corpus entry by id against the local mock SUT and return its `ExecutionResult`.
 * The entry's `sourcePath` (from an in-memory compile) locates the authored module; env's
 * `baseUrl` is redirected to the mock (an ephemeral port), unless `ATP_BASE_URL` already
 * points somewhere. The run records the compile's `manifestHash`/`gitSha` for provenance.
 */
export async function runById(id: string, opts: RunOptions = {}): Promise<ExecutionResult> {
  const root = opts.root ?? process.cwd();
  const manifest = await compile({ root });
  const entry = manifest.entries.find((e) => e.id === id);
  if (!entry) {
    throw new Error(`unknown test id "${id}" (run \`atp list\` to see available ids)`);
  }

  const def = await importDefault(resolve(root, entry.sourcePath));
  const matrix = cellCoords(id);

  const preset = process.env.ATP_BASE_URL;
  let sut: MockSut | undefined;
  const baseUrl = preset ?? (sut = await startMockSut()).url;
  try {
    const common: RunOptionsBase = {
      env: { ...(resolveEnv(def.env, matrix) ?? {}), baseUrl },
      envName: opts.envName ?? "local",
      matrix,
      entryId: id,
      manifestHash: manifest.manifestHash,
      gitSha: manifest.gitSha,
    };
    if (isSuite(def)) return await runSuite(def, common);
    const testOpts: RunTestOptions = { ...common, params: opts.params };
    return await runTest(def, testOpts);
  } finally {
    await sut?.close();
  }
}

/** A compact glyph per step status for the CLI result summary. */
function mark(status: StepStatus): string {
  const glyphs: Record<StepStatus, string> = {
    passed: "✓",
    failed: "✗",
    errored: "!",
    skipped: "-",
    cancelled: "×",
  };
  return glyphs[status];
}

/** One line per entry: `id  kind  [tags]  owner`. */
export function formatList(entries: ManifestEntry[]): string {
  if (entries.length === 0) return "(no tests found)";
  return entries
    .map((e) => {
      const tags = e.tags.length ? `[${e.tags.join(", ")}]` : "";
      return `${e.id}\t${e.kind}\t${tags}\t${e.owner ?? ""}`.trimEnd();
    })
    .join("\n");
}

/** A human-readable run summary: a status headline, then one line per step. */
export function formatResult(result: ExecutionResult): string {
  const m = result.metrics;
  const passedAssertions = m.totalAssertions - m.failedAssertions;
  const head = `${result.entryId} — ${result.status} (${m.passedSteps}/${m.totalSteps} steps, ${passedAssertions}/${m.totalAssertions} assertions) in ${result.durationMs}ms`;
  const steps = result.steps.map((s) => `  ${mark(s.status)} ${s.id} — ${s.status}`);
  const error = result.error ? [`  error: ${result.error}`] : [];
  return [head, ...steps, ...error].join("\n");
}
