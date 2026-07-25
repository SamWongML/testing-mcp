import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { compile, importDef } from "@atp/compile";
import { expandUnits, isSuite, runSuite, runTest, type RunOptionsBase } from "@atp/engine";
import { renderReport, reportExtension, type ReportFormat } from "@atp/reporting";
import type { ExecutionResult, ManifestEntry, StepStatus } from "@atp/schema";

import { goldenFromResult, type GoldenBlock, type GoldenCapture } from "./golden";
import { startMockSut, type MockSut } from "./mock-sut";
import { strictViolations, type Violation } from "./strict";

/**
 * The `atp` CLI's command layer (research §P4). `list`/`validate` are thin views over an
 * in-memory `compile()` (always fresh — no stale `dist/manifest.json`). `run` locates an
 * entry's source by id, imports the authored definition (which carries the real functions
 * the manifest strips), and executes it in-process via the engine against the local mock
 * SUT, so the inner loop works fully offline.
 */

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

export interface ValidateResult {
  entries: number;
  violations: Violation[];
}

/**
 * Compile the corpus (throws on a compile error) and check it against the §19 strictness
 * rules. Violations are returned, not thrown, so the caller can print every one of them.
 */
export async function validate(root: string = process.cwd()): Promise<ValidateResult> {
  const manifest = await compile({ root });
  return { entries: manifest.entries.length, violations: strictViolations(manifest) };
}

export interface RunOptions {
  root?: string;
  params?: Record<string, unknown>;
  envName?: string;
  /** An explicit SUT base URL. When set, the local mock is never started. */
  baseUrl?: string;
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

  const def = await importDef(resolve(root, entry.sourcePath));
  // Reuse the engine's own cell enumeration so the run's `{{matrix.*}}` coords and per-cell
  // env are exactly what the manifest recorded — no re-parsing the id string (which would
  // lose the authored value types and mishandle separators inside a dimension value).
  const unit = expandUnits(def).find((u) => u.id === id);

  const preset = opts.baseUrl ?? process.env.ATP_BASE_URL;
  let sut: MockSut | undefined;
  const baseUrl = preset ?? (sut = await startMockSut()).url;
  try {
    const common: RunOptionsBase = {
      env: { ...(unit?.env ?? {}), baseUrl },
      envName: opts.envName ?? "local",
      matrix: unit?.matrix ?? {},
      entryId: id,
      manifestHash: manifest.manifestHash,
      gitSha: manifest.gitSha,
    };
    if (isSuite(def)) return await runSuite(def, common);
    return await runTest(def, { ...common, params: opts.params });
  } finally {
    await sut?.close();
  }
}

/**
 * Run `id` once against a **real** SUT and derive golden-master parity assertions from what
 * it answered (research §19 step 4) — the capture step that replaces `atp import`'s
 * deliberately weak `status lt 500` scaffold.
 *
 * The base URL must be explicit (`--base-url` or `ATP_BASE_URL`). `runById` starts a local
 * mock when neither is present, and assertions captured from the mock would describe fixture
 * data while looking exactly like real coverage — so this refuses rather than falls back.
 */
export async function captureGolden(id: string, opts: RunOptions = {}): Promise<GoldenCapture> {
  const baseUrl = opts.baseUrl ?? process.env.ATP_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      "atp golden: no SUT base URL — pass --base-url <url> or set ATP_BASE_URL. Parity " +
        "assertions must be captured from the real service, never the local mock.",
    );
  }
  return goldenFromResult(await runById(id, { ...opts, baseUrl }));
}

/**
 * Render `result` in the given format and write it as a local artifact (P5 CLI wiring).
 * Defaults the filename to `<sanitized-entryId>.<ext>` in `cwd`; `out` overrides the path.
 * Returns the path written so the caller can report it.
 */
export async function writeReport(
  result: ExecutionResult,
  format: ReportFormat,
  out?: string,
): Promise<string> {
  const path = out ?? `${sanitizeId(result.entryId)}.${reportExtension(format)}`;
  await writeFile(path, renderReport(result, format), "utf8");
  return path;
}

/** Make an entry id safe as a filename (matrix ids carry `#`, `=`, `,`). */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, "_");
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

/** Golden blocks as pasteable source, one labelled `assert` per node. */
export function formatGolden(blocks: GoldenBlock[]): string {
  return blocks.map((b) => `// ${b.nodeId}\nassert: ${b.source},`).join("\n\n");
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
