import type { Extractor } from "@atp/schema";

import type { EngineResponse } from "./context";
import { getByPath } from "./util";

/**
 * Extraction (research §10.3): each `{ as, from }` reads a dot-path from the
 * response (`body.token`, `body.user.id`, `status`, `headers.x`) and publishes it
 * to the run's var bag, where later nodes reference it via `{{nodes.X.as}}`.
 */
export function extract(
  extractors: readonly Extractor[],
  response: EngineResponse,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { as, from } of extractors) {
    out[as] = getByPath(response, from);
  }
  return out;
}
