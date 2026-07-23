/**
 * A deliberately small JSONPath evaluator for the `jsonpath` assertion operator.
 *
 * Supports the child-and-index subset that covers response addressing:
 * `$.a.b`, `$.a[0]`, `$['a']`, `$["a"]`. Wildcards, recursive descent, slices and
 * filters are intentionally out of scope (add them if a real test needs them).
 * Returns the list of matched nodes (empty when the path does not resolve).
 */

type Token = { type: "key"; name: string } | { type: "index"; index: number };

const SEGMENT = /\.([A-Za-z_$][\w$]*)|\[(\d+)\]|\['([^']*)'\]|\["([^"]*)"\]/g;

function tokenize(expr: string): Token[] {
  let e = expr.trim();
  if (e.startsWith("$")) e = e.slice(1);
  const tokens: Token[] = [];
  SEGMENT.lastIndex = 0;
  let expected = 0;
  let m: RegExpExecArray | null;
  while ((m = SEGMENT.exec(e)) !== null) {
    if (m.index !== expected) break; // an unsupported gap — stop rather than mis-match
    expected = SEGMENT.lastIndex;
    if (m[1] !== undefined) tokens.push({ type: "key", name: m[1] });
    else if (m[2] !== undefined) tokens.push({ type: "index", index: Number(m[2]) });
    else if (m[3] !== undefined) tokens.push({ type: "key", name: m[3] });
    else if (m[4] !== undefined) tokens.push({ type: "key", name: m[4] });
  }
  return tokens;
}

/** Evaluate a JSONPath expression against `root`, returning matched nodes. */
export function queryJsonPath(expr: string, root: unknown): unknown[] {
  let current: unknown[] = [root];
  for (const tok of tokenize(expr)) {
    const next: unknown[] = [];
    for (const node of current) {
      if (node == null || typeof node !== "object") continue;
      if (tok.type === "key") {
        if (!Array.isArray(node) && tok.name in node) {
          next.push((node as Record<string, unknown>)[tok.name]);
        }
      } else if (Array.isArray(node) && tok.index < node.length) {
        next.push(node[tok.index]);
      }
    }
    current = next;
  }
  return current;
}
