import type { AuthoredTestCase } from "@atp/schema";
import { z } from "zod";

/**
 * Resolve a test's params: run the authored `params` builder (so `.default()`s apply
 * and the input is validated) or pass the raw input through when the test declares no
 * params. Template strings survive `.parse` untouched — the runner resolves them later
 * against the run context (research §10.2). Shared by the single-test runner and the
 * suite normalizer (a `useTest` node resolves its reused test's params here).
 */
export function resolveParams(
  test: Pick<AuthoredTestCase, "params">,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!test.params) return { ...(input ?? {}) };
  return test.params(z).parse(input ?? {}) as Record<string, unknown>;
}
