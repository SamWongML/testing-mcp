import type { ExecutionResult } from "@atp/schema";

import { diagnose } from "./diagnose";
import { ms } from "./util";

/**
 * `llm_summary` (research §14) — a compact, token-efficient synopsis an autonomous agent
 * can act on without reading the full trace: what ran, what failed, the likely cause, and
 * the next action. A passing run is a single line; a failure adds the offending steps and
 * the heuristic diagnosis.
 */
export function renderSummary(result: ExecutionResult): string {
  const m = result.metrics;
  const passedAssertions = m.totalAssertions - m.failedAssertions;
  const kind = result.kind ?? "test";
  const head =
    `${result.entryId} [${kind}] ${result.status} — ` +
    `${m.passedSteps}/${m.totalSteps} steps, ` +
    `${passedAssertions}/${m.totalAssertions} assertions, ${ms(result.durationMs)}`;

  if (result.status === "passed") return head;

  const lines = [head];

  const notPassed = result.steps.filter((s) => s.status !== "passed");
  if (notPassed.length > 0) {
    lines.push(`not passed: ${notPassed.map((s) => `${s.id} (${s.status})`).join(", ")}`);
  }

  const d = diagnose(result);
  if (d) {
    lines.push(`likely cause: ${d.cause} — ${d.detail}`);
    lines.push(`next action: ${d.nextAction}`);
  }

  return lines.join("\n");
}
