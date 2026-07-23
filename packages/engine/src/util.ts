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
