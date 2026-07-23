/** Shared engine helpers: path addressing (`body.user.id`) and structural equality. */

/** Resolve a dot-path (`body.token`, `headers.content-type`) against an object. */
export function getByPath(obj: unknown, path: string): unknown {
  return getBySegments(obj, path.split("."));
}

/** Walk pre-split path segments, returning `undefined` at the first missing hop. */
export function getBySegments(obj: unknown, segments: readonly string[]): unknown {
  let cur = obj;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Deep-map a value, replacing each string leaf via `fn` and recursing into arrays
 * and plain objects. `fn`'s result is not re-walked, so a string that resolves to a
 * non-string (or another string) is taken as final — shared by template resolution
 * and redaction, which differ only in the leaf transform.
 */
export function mapDeepStrings(value: unknown, fn: (s: string) => unknown): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapDeepStrings(v, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapDeepStrings(v, fn);
    return out;
  }
  return value;
}

/** Structural deep equality for assertion comparisons (order-insensitive on keys). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}
