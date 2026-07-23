import type { ExecutionResult, StepResult, StepStatus } from "@atp/schema";

import { diagnose } from "./diagnose";
import { escapeXml, fmtValue, ms } from "./util";

/**
 * Self-contained HTML report (research §14) — a single file with inlined CSS and no
 * external references, for humans: a status header, the heuristic likely cause, and an
 * execution timeline where each step's redacted request/response trace is expandable via
 * a native `<details>` element (no JS needed). Every dynamic value is HTML-escaped.
 */
export function renderHtml(result: ExecutionResult): string {
  const title = escapeXml(`Report — ${result.entryId}`);
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    renderHeader(result),
    renderDiagnosis(result),
    renderTimeline(result),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function renderHeader(result: ExecutionResult): string {
  const m = result.metrics;
  const rows: [string, string | undefined][] = [
    ["Run", result.runId],
    ["Kind", result.kind ?? "test"],
    ["Env", result.env],
    ["Steps", `${m.passedSteps}/${m.totalSteps} passed`],
    ["Assertions", `${m.totalAssertions - m.failedAssertions}/${m.totalAssertions} passed`],
    ["Duration", ms(result.durationMs)],
    ["Manifest", result.manifestHash],
    ["Git SHA", result.gitSha],
  ];
  const meta = rows
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<div><dt>${escapeXml(k)}</dt><dd>${escapeXml(v as string)}</dd></div>`)
    .join("");
  const runError = result.error
    ? `<p class="run-error">${escapeXml(result.error)}</p>`
    : "";
  return (
    `<header>` +
    `<h1>${escapeXml(result.entryId)}</h1>` +
    `<span class="badge badge-${result.status}">${escapeXml(result.status)}</span>` +
    `<dl class="meta">${meta}</dl>` +
    runError +
    `</header>`
  );
}

function renderDiagnosis(result: ExecutionResult): string {
  const d = diagnose(result);
  if (!d) return "";
  return (
    `<section class="diagnosis">` +
    `<h2>Likely cause</h2>` +
    `<p><strong>${escapeXml(d.cause)}</strong> — ${escapeXml(d.detail)}</p>` +
    `<p class="next">Next action: ${escapeXml(d.nextAction)}</p>` +
    `</section>`
  );
}

function renderTimeline(result: ExecutionResult): string {
  const max = Math.max(1, ...result.steps.map((s) => s.timingMs ?? 0));
  const items = result.steps.map((s) => renderStep(s, max)).join("");
  return `<section class="timeline"><h2>Timeline</h2><ul class="steps">${items}</ul></section>`;
}

function renderStep(step: StepResult, maxTiming: number): string {
  const pct = Math.round(((step.timingMs ?? 0) / maxTiming) * 100);
  const head =
    `<div class="step-head">` +
    `<span class="step-id">${escapeXml(step.id)}</span>` +
    `<span class="step-status">${escapeXml(step.status)}</span>` +
    `<span class="step-time">${escapeXml(ms(step.timingMs))} · ${step.attempts} attempt(s)</span>` +
    `</div>` +
    `<div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>`;

  const traceParts: string[] = [];
  if (step.request) {
    traceParts.push(`<h4>Request</h4><pre>${escapeXml(JSON.stringify(step.request, null, 2))}</pre>`);
  }
  if (step.response) {
    traceParts.push(`<h4>Response</h4><pre>${escapeXml(JSON.stringify(step.response, null, 2))}</pre>`);
  }
  if (step.assertions.length > 0) {
    const rows = step.assertions.map(renderAssertion).join("");
    traceParts.push(`<h4>Assertions</h4><ul class="assertions">${rows}</ul>`);
  }
  if (step.error) {
    traceParts.push(`<p class="err">${escapeXml(step.error)}</p>`);
  }

  const details = `<details><summary>Request / Response</summary><div class="trace">${traceParts.join("")}</div></details>`;
  return `<li class="step step-${escapeXml(step.status)}">${head}${details}</li>`;
}

function renderAssertion(a: StepResult["assertions"][number]): string {
  const glyph = a.ok ? "✓" : "✗";
  const op = a.op ?? "fn";
  const where = a.path ? ` at <code>${escapeXml(a.path)}</code>` : "";
  const cmp =
    !a.ok && (a.expected !== undefined || a.actual !== undefined)
      ? ` — expected <code>${escapeXml(fmtValue(a.expected))}</code>, actual <code>${escapeXml(fmtValue(a.actual))}</code>`
      : "";
  const message = a.message ? ` — ${escapeXml(a.message)}` : "";
  const cls = a.ok ? "ok" : "fail";
  return `<li class="${cls}">${glyph} <code>${escapeXml(op)}</code>${where}${cmp}${message}</li>`;
}

const badgeColors: Record<StepStatus, string> = {
  passed: "#137333",
  failed: "#b3261e",
  errored: "#8a1f11",
  skipped: "#5f6368",
  cancelled: "#946200",
};

const STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; padding: 1.5rem; line-height: 1.5; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
h2 { font-size: 1.1rem; margin: 1.5rem 0 .5rem; border-bottom: 1px solid #8883; padding-bottom: .25rem; }
h4 { margin: .75rem 0 .25rem; font-size: .85rem; text-transform: uppercase; letter-spacing: .05em; opacity: .7; }
.badge { display: inline-block; padding: .1rem .6rem; border-radius: 1rem; color: #fff; font-size: .8rem; font-weight: 600; }
${(Object.keys(badgeColors) as StepStatus[]).map((k) => `.badge-${k} { background: ${badgeColors[k]}; }`).join("\n")}
.meta { display: flex; flex-wrap: wrap; gap: .25rem 1.5rem; margin: .75rem 0 0; }
.meta div { display: flex; gap: .4rem; }
.meta dt { font-weight: 600; opacity: .7; margin: 0; }
.meta dd { margin: 0; }
.run-error { color: #b3261e; font-weight: 600; }
.diagnosis { background: #fbe9e7aa; border-left: 4px solid #b3261e; padding: .5rem 1rem; border-radius: 4px; }
.diagnosis .next { font-style: italic; opacity: .85; }
.steps { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: .5rem; }
.step { border: 1px solid #8883; border-radius: 6px; padding: .5rem .75rem; }
.step-head { display: flex; align-items: baseline; gap: .75rem; }
.step-id { font-weight: 600; font-family: ui-monospace, monospace; }
.step-status { font-size: .8rem; text-transform: uppercase; opacity: .7; }
.step-time { margin-left: auto; font-size: .8rem; opacity: .7; }
.step-failed { border-color: #b3261e; }
.step-errored { border-color: #8a1f11; }
.bar { height: 4px; background: #8882; border-radius: 2px; margin: .4rem 0; overflow: hidden; }
.bar-fill { height: 100%; background: #1a73e8; }
.step-failed .bar-fill, .step-errored .bar-fill { background: #b3261e; }
pre { background: #8881; padding: .5rem; border-radius: 4px; overflow-x: auto; font-size: .8rem; }
.assertions { margin: 0; padding-left: 1.2rem; font-size: .85rem; }
.assertions .fail { color: #b3261e; }
.err { color: #b3261e; white-space: pre-wrap; }
code { font-family: ui-monospace, monospace; }
`.trim();
