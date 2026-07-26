import type { Assertion, Manifest, RequestSpec } from "@atp/schema";

import { CHAIN_PLACEHOLDER } from "./import";

/**
 * Strictness rules for `atp validate` — the guard that stops a half-finished migration from
 * shipping a corpus that *cannot fail*.
 *
 * `atp import` scaffolds every request with a deliberately weak `status lt 500` assertion and
 * an `__TODO_CHAIN__` placeholder wherever it could not resolve an Insomnia response-ref. Left
 * unfinished, those compose: the request hits a bogus URL, gets a 404, and `status < 500`
 * passes. These two rules turn that silent trap into a build error.
 *
 * Pure and offline: they operate on the compiled manifest, so the check is independent of how
 * an entry was authored.
 */

export type StrictRule = "unwired-chain" | "non-pinning-assert";

/** One rule violation, addressed by the entry + node it was found on. */
export interface Violation {
  entryId: string;
  nodeId: string;
  rule: StrictRule;
  detail: string;
}

/** A range comparison on `status` — passes for any 4xx, so it pins nothing. */
function isStatusRangeAssert(a: Assertion): boolean {
  return "path" in a && a.path === "status" && (a.op === "lt" || a.op === "gt");
}

/** True when the placeholder survives anywhere in `value` (nested objects included). */
function carriesPlaceholder(value: unknown): boolean {
  // `body` is `z.unknown()`, so it can hold something JSON drops entirely (a function, a
  // symbol) — for which `stringify` returns `undefined` despite its `string` return type.
  const json = JSON.stringify(value) as string | undefined;
  return json !== undefined && json.includes(CHAIN_PLACEHOLDER);
}

/** The request fields still carrying an unresolved chain placeholder, in a stable order. */
function unwiredFields(request: RequestSpec): string[] {
  const fields = {
    url: request.url,
    headers: request.headers,
    query: request.query,
    body: request.body,
    authRef: request.authRef,
  };
  return Object.entries(fields)
    .filter(([, value]) => carriesPlaceholder(value))
    .map(([field]) => field);
}

/** Collect every strictness violation in `manifest` (empty array = the corpus is strict). */
export function strictViolations(manifest: Manifest): Violation[] {
  const violations: Violation[] = [];
  for (const entry of manifest.entries) {
    for (const node of entry.nodes) {
      const at = { entryId: entry.id, nodeId: node.id };

      for (const field of unwiredFields(node.request)) {
        violations.push({
          ...at,
          rule: "unwired-chain",
          detail: `unresolved ${CHAIN_PLACEHOLDER} in ${field}`,
        });
      }

      if (node.assert.every(isStatusRangeAssert)) {
        const ops = node.assert
          .map((a) => ("path" in a ? `status ${a.op} ${String(a.value)}` : ""))
          .join(", ");
        violations.push({
          ...at,
          rule: "non-pinning-assert",
          detail: node.assert.length
            ? `only range assertions on status (${ops}) — a 404 would pass`
            : "no assertions — this node cannot fail",
        });
      }
    }
  }
  return violations;
}
