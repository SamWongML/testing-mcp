import type { ExecutionResult } from "@atp/schema";

/**
 * Full-fidelity JSON trace — request/response, headers, timings,
 * assertions, extracted vars — for programmatic analysis and S3 storage. The
 * `ExecutionResult` is already redacted before it reaches a renderer, so this
 * is a straight pretty-print; no field is dropped or transformed.
 */
export function renderTrace(result: ExecutionResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}
