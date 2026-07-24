import type { DeclarativeAssertion } from "@atp/schema";

/**
 * Golden-master parity helper (research §19 step 4). Migration is only trustworthy once a
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
