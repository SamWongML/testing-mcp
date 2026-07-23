import type { AssertionResult, ExecutionResult, StepResult } from "@atp/schema";

import { escapeXml, fmtValue, secs } from "./util";

/**
 * JUnit XML report (research §14) — drops straight into CI dashboards. One `<testsuite>`
 * per run, one `<testcase>` per step: `failed` → `<failure>`, `errored` → `<error>`,
 * and `skipped`/`cancelled` → `<skipped>` (JUnit has no cancelled state). All dynamic
 * values are XML-escaped.
 */
export function renderJUnit(result: ExecutionResult): string {
  const steps = result.steps;
  const failures = steps.filter((s) => s.status === "failed").length;
  const errors = steps.filter((s) => s.status === "errored").length;
  const skipped = steps.filter((s) => s.status === "skipped" || s.status === "cancelled").length;

  const attrs =
    `name="${escapeXml(result.entryId)}" tests="${steps.length}" ` +
    `failures="${failures}" errors="${errors}" skipped="${skipped}" time="${secs(result.durationMs)}"`;

  const cases = steps.map((s) => renderCase(s, result.entryId)).join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites ${attrs}>\n` +
    `  <testsuite ${attrs} timestamp="${escapeXml(result.startedAt)}">\n` +
    `${cases}\n` +
    `  </testsuite>\n` +
    `</testsuites>\n`
  );
}

function renderCase(step: StepResult, entryId: string): string {
  const open =
    `    <testcase name="${escapeXml(step.id)}" ` +
    `classname="${escapeXml(entryId)}" time="${secs(step.timingMs)}"`;

  if (step.status === "failed") {
    const detail = failureDetail(step);
    return `${open}>\n      <failure message="${escapeXml(detail)}">${escapeXml(detail)}</failure>\n    </testcase>`;
  }
  if (step.status === "errored") {
    const detail = step.error ?? `step "${step.id}" errored`;
    return `${open}>\n      <error message="${escapeXml(detail)}">${escapeXml(detail)}</error>\n    </testcase>`;
  }
  if (step.status === "cancelled") {
    return `${open}>\n      <skipped message="cancelled"/>\n    </testcase>`;
  }
  if (step.status === "skipped") {
    return `${open}>\n      <skipped/>\n    </testcase>`;
  }
  return `${open}/>`;
}

/** A one-line description of why a step failed, from its failed assertions. */
function failureDetail(step: StepResult): string {
  const failed = step.assertions.filter((a) => !a.ok);
  if (failed.length === 0) return step.error ?? `step "${step.id}" failed`;
  return failed.map(assertionLine).join("; ");
}

function assertionLine(a: AssertionResult): string {
  const op = a.op ?? "fn";
  const where = a.path ? ` at ${a.path}` : "";
  const cmp =
    a.expected !== undefined || a.actual !== undefined
      ? `: expected ${fmtValue(a.expected)}, actual ${fmtValue(a.actual)}`
      : "";
  return `assertion ${op}${where} failed${cmp}`;
}
