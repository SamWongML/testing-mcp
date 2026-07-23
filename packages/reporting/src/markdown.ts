import type { AssertionResult, ExecutionResult, StepResult, StepStatus } from "@atp/schema";

import { diagnose } from "./diagnose";
import { fmtValue, ms } from "./util";

/**
 * Markdown report (research §14) — the agent-friendly format returned inline by
 * `get_report`: a status header, a per-step table, the heuristic likely cause, and a
 * failures section with request/response and assertion detail. Derived from the same
 * `ExecutionResult` as every other renderer (ADR-006).
 */

const GLYPH: Record<StepStatus, string> = {
  passed: "✅",
  failed: "❌",
  errored: "🛑",
  skipped: "⏭️",
  cancelled: "🚫",
};

/** Escape a value for a Markdown table cell (only `|` needs escaping). */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

export function renderMarkdown(result: ExecutionResult): string {
  const m = result.metrics;
  const out: string[] = [`# Report — ${result.entryId}`, ""];

  out.push(`- **Status:** ${result.status}`);
  out.push(`- **Run:** ${result.runId}`);
  out.push(`- **Kind:** ${result.kind ?? "test"}`);
  if (result.env) out.push(`- **Env:** ${result.env}`);
  out.push(`- **Steps:** ${m.passedSteps}/${m.totalSteps} passed`);
  out.push(`- **Assertions:** ${m.totalAssertions - m.failedAssertions}/${m.totalAssertions} passed`);
  out.push(`- **Duration:** ${ms(result.durationMs)}`);
  if (result.manifestHash) out.push(`- **Manifest:** ${result.manifestHash}`);
  if (result.gitSha) out.push(`- **Git SHA:** ${result.gitSha}`);

  if (result.error) {
    out.push("", `> **Run error:** ${result.error}`);
  }

  out.push("", "## Steps", "", "| Step | Status | Attempts | Time |", "|---|---|---|---|");
  for (const s of result.steps) {
    out.push(`| ${cell(s.id)} | ${GLYPH[s.status]} ${s.status} | ${s.attempts} | ${ms(s.timingMs)} |`);
  }

  const d = diagnose(result);
  if (d) {
    out.push("", "## Likely cause", "", `**${d.cause}** — ${d.detail}`, "", `_Next action: ${d.nextAction}_`);
  }

  const failures = result.steps.filter((s) => s.status === "failed" || s.status === "errored");
  if (failures.length > 0) {
    out.push("", "## Failures");
    for (const s of failures) out.push("", ...renderFailure(s));
  }

  return out.join("\n") + "\n";
}

function renderFailure(step: StepResult): string[] {
  const lines = [`### ${step.id} — ${step.status}`, ""];
  if (step.request) {
    lines.push(`- **Request:** \`${step.request.method} ${step.request.url}\``);
  }
  if (step.response) {
    lines.push(`- **Response:** \`${step.response.status}\``);
  }
  if (step.error) {
    lines.push(`- **Error:** ${step.error}`);
  }
  const failed = step.assertions.filter((a) => !a.ok);
  if (failed.length > 0) {
    lines.push("- **Assertions:**");
    for (const a of failed) lines.push(`  - ❌ ${renderAssertion(a)}`);
  }
  return lines;
}

function renderAssertion(a: AssertionResult): string {
  const op = a.op ?? "fn";
  const where = a.path ? ` at \`${a.path}\`` : "";
  const cmp =
    a.expected !== undefined || a.actual !== undefined
      ? ` — expected \`${fmtValue(a.expected)}\`, actual \`${fmtValue(a.actual)}\``
      : "";
  const message = a.message ? ` — ${a.message}` : "";
  return `\`${op}\`${where}${cmp}${message}`;
}
