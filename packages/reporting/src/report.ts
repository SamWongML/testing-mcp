import type { ExecutionResult } from "@atp/schema";

import { renderHtml } from "./html";
import { renderJUnit } from "./junit";
import { renderMarkdown } from "./markdown";
import { renderSummary } from "./summary";
import { renderTrace } from "./trace";

/**
 * Format dispatch over the canonical renderers (research §14, ADR-006). A new output
 * format is an additive entry here — no caller changes. The CLI's `--report` flag and
 * the future `get_report` MCP tool both route through this one map.
 */
export type ReportFormat = "md" | "html" | "junit" | "json" | "summary";

const RENDERERS: Record<ReportFormat, (result: ExecutionResult) => string> = {
  md: renderMarkdown,
  html: renderHtml,
  junit: renderJUnit,
  json: renderTrace,
  summary: renderSummary,
};

const EXTENSIONS: Record<ReportFormat, string> = {
  md: "md",
  html: "html",
  junit: "xml",
  json: "json",
  summary: "txt",
};

/** The formats `renderReport` understands, in a stable order. */
export const REPORT_FORMATS = Object.keys(RENDERERS) as ReportFormat[];

/** Narrow an arbitrary string to a `ReportFormat` (for CLI flag validation). */
export function isReportFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as string[]).includes(value);
}

/** Render `result` in the requested format. Throws on an unknown format. */
export function renderReport(result: ExecutionResult, format: ReportFormat): string {
  const render = RENDERERS[format];
  if (!render) {
    throw new Error(`unknown report format "${format}" (expected: ${REPORT_FORMATS.join(", ")})`);
  }
  return render(result);
}

/** The file extension a given format's artifact is written with (`junit` → `xml`). */
export function reportExtension(format: ReportFormat): string {
  return EXTENSIONS[format];
}
