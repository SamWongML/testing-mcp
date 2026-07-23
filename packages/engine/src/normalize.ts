import {
  deriveParamsSchema,
  manifestEntrySchema,
  matrixSchema,
  stepSchema,
  type Assertion,
  type AuthoredAssertion,
  type AuthoredStep,
  type AuthoredSuite,
  type AuthoredTestCase,
  type ManifestEntry,
  type Matrix,
  type Step,
} from "@atp/schema";

import { hashFn } from "./fnHash";
import { expandUnits } from "./matrix";
import { isSuite, planSuite } from "./suite";

/**
 * Normalize an authored test/suite into serializable manifest entries (research §7.4,
 * §9, ADR-003). This is the compile step's core transform: it strips every function
 * from the authored form — `fn` predicates become `{ fnHash }` markers, the `params`
 * builder becomes a JSON Schema — so the manifest is a pure, portable, introspectable
 * catalog. A suite's node map is flattened + topologically ordered (cycles and unknown
 * edges throw here, the §12 compile-time check); a matrix expands into one entry per
 * cartesian cell (§7.3), each carrying its resolved env and cell coordinates.
 */

/** Above this authored `timeoutMs`, a run is treated as long-running (→ MCP Task by
 *  default, P8) unless the author sets `isLongRunning` explicitly. */
const LONG_RUNNING_TIMEOUT_MS = 30_000;

type AuthoredDef = AuthoredTestCase | AuthoredSuite;

/** Replace an authored `fn` predicate with its content-hash marker; declarative
 *  assertions are already serializable and pass through unchanged. */
function normalizeAssertion(assertion: AuthoredAssertion): Assertion {
  if ("fn" in assertion) {
    const marker = { fnHash: hashFn(assertion.fn) };
    return assertion.message !== undefined ? { ...marker, message: assertion.message } : marker;
  }
  return assertion;
}

/** Normalize one authored step/node: hash its fn assertions, then apply schema
 *  defaults + validation (`assert`/`extract`/`needs` default to `[]`). */
function normalizeStep(step: AuthoredStep, needs: string[]): Step {
  return stepSchema.parse({
    ...step,
    needs,
    assert: (step.assert ?? []).map(normalizeAssertion),
  });
}

/** A cell's coordinates → a singleton matrix (`{ region: ["us"] }`): a schema-valid,
 *  self-describing record of which cell an expanded entry represents. Omitted when the
 *  unit has no matrix (a plain, non-matrixed entry). */
function toCellMatrix(coords: Record<string, unknown>): Matrix | undefined {
  const dims = Object.entries(coords);
  return dims.length ? Object.fromEntries(dims.map(([k, v]) => [k, [v]])) : undefined;
}

/** Compile an authored definition into its normalized manifest entries (one per matrix
 *  cell, or a single entry when there is no matrix). Every entry is validated. */
export function normalize(def: AuthoredDef, sourcePath: string): ManifestEntry[] {
  // Validate the authored matrix at compile time: an empty dimension (`{ region: [] }`)
  // would otherwise expand to zero units and vanish silently from the manifest.
  if (def.matrix) matrixSchema.parse(def.matrix);
  const suite = isSuite(def);
  const nodes: Step[] = suite
    ? planSuite(def).map((node) => normalizeStep(node.step, node.needs))
    : def.steps.map((step) => normalizeStep(step, step.needs ?? []));
  const paramsSchema = !suite && def.params ? deriveParamsSchema(def.params) : undefined;
  const isLongRunning = def.isLongRunning ?? (def.timeoutMs ?? 0) > LONG_RUNNING_TIMEOUT_MS;

  return expandUnits(def).map((unit) =>
    manifestEntrySchema.parse({
      id: unit.id,
      kind: suite ? "suite" : "test",
      version: def.version,
      title: def.title,
      // undefined passes through — `manifestEntrySchema` defaults `tags` to `[]`.
      tags: def.tags,
      owner: def.owner,
      timeoutMs: def.timeoutMs,
      isLongRunning,
      paramsSchema,
      matrix: toCellMatrix(unit.matrix),
      env: unit.env,
      nodes,
      sourcePath,
    }),
  );
}
