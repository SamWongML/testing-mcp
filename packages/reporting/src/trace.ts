import type { ExecutionResult } from "@atp/schema";

/**
 * Full-fidelity JSON trace (research §14) — request/response, headers, timings,
 * assertions, extracted vars — for programmatic analysis and S3 storage. The
 * `ExecutionResult` is already redacted before it reaches a renderer (§21), so this
 * is a straight pretty-print; no field is dropped or transformed.
 */
export function renderTrace(result: ExecutionResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}
