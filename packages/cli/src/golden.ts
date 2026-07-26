import type { DeclarativeAssertion, ExecutionResult } from "@atp/schema";

/**
 * Golden-master parity helper (step 4). Migration is only trustworthy once a
 * converted test is shown to reproduce the original request's behavior. Given a captured
 * baseline response, {@link goldenAssertions} derives a conservative set of parity assertions
 * — the exact status, plus a per-field *shape* check for each scalar key — and
 * {@link renderAssertions} formats them as TS source to paste into the migrated test's `assert`.
 *
 * Conservative on purpose: run-to-run-variable values (tokens, ids, timestamps) get a type
 * assertion rather than an equality one, and nested objects/arrays are left for the author to
 * pin deliberately — a scaffold that over-asserts is worse than one that under-asserts.
 */

/** A captured baseline: the response status and parsed JSON body of one request. */
export interface BaselineResponse {
  status: number;
  body: unknown;
}

/** Derive parity assertions (status + scalar key-field shape) from a captured baseline. */
export function goldenAssertions(response: BaselineResponse): DeclarativeAssertion[] {
  const asserts: DeclarativeAssertion[] = [{ path: "status", op: "eq", value: response.status }];

  const { body } = response;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value === "string") asserts.push({ path: `body.${key}`, op: "isString" });
      else if (typeof value === "number") asserts.push({ path: `body.${key}`, op: "isNumber" });
      else if (typeof value === "boolean") asserts.push({ path: `body.${key}`, op: "eq", value });
      // Nested objects/arrays/null are intentionally left for the author to pin deliberately.
    }
  }
  return asserts;
}

/** Format a JS value the way it should appear inside a generated assertion literal. */
function value(v: unknown): string {
  return JSON.stringify(v);
}

/** Render parity assertions as a TS array literal for pasting into a migrated test's `assert`. */
export function renderAssertions(asserts: DeclarativeAssertion[]): string {
  const lines = asserts.map((a) => {
    const parts = [`path: ${value(a.path)}`, `op: ${value(a.op)}`];
    if (a.value !== undefined) parts.push(`value: ${value(a.value)}`);
    return `  { ${parts.join(", ")} },`;
  });
  return `[\n${lines.join("\n")}\n]`;
}

/** One node's rendered parity assertions, ready to paste over its scaffolded `assert`. */
export interface GoldenBlock {
  nodeId: string;
  /** TS source: the `assert` array literal derived from that node's captured response. */
  source: string;
}

export interface GoldenCapture {
  blocks: GoldenBlock[];
  /** Nodes that did not execute, so no baseline exists to derive assertions from. */
  missing: string[];
}

/**
 * Derive per-node parity blocks from one captured run.
 *
 * A node that did not execute — skipped because an upstream node failed, cancelled, or
 * errored before a response arrived — yields **no** assertions and is reported in `missing`
 * instead. Emitting from a partial run would silently pin the wrong thing, which is worse
 * than emitting nothing. A node that ran and *failed* is still a real baseline: its response
 * is what the SUT actually does, and that is exactly what golden-master parity captures.
 */
export function goldenFromResult(result: ExecutionResult): GoldenCapture {
  const blocks: GoldenBlock[] = [];
  const missing: string[] = [];
  for (const step of result.steps) {
    if (!step.response) {
      missing.push(step.id);
      continue;
    }
    const { status, body } = step.response;
    blocks.push({ nodeId: step.id, source: renderAssertions(goldenAssertions({ status, body })) });
  }
  return { blocks, missing };
}
