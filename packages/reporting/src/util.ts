/** Small shared helpers for the renderers (research §14). Kept internal to the package. */

/**
 * Escape a string for use in XML/HTML text or attribute context. The set covers both
 * (`&`, `<`, `>`, `"`, `'`) so the junit (XML) and html renderers share one escaper —
 * there is exactly one place a raw value can leak into markup.
 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `42ms`, or `—` when the timing is unknown. */
export function ms(value: number | undefined): string {
  return value === undefined ? "—" : `${value}ms`;
}

/** Seconds (JUnit `time=`), always a plain number string; unknown → `0`. */
export function secs(value: number | undefined): string {
  return value === undefined ? "0" : (value / 1000).toString();
}

/** Compact display of an arbitrary assertion value: strings quoted, objects as JSON. */
export function fmtValue(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
