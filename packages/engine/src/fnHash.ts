import { createHash } from "node:crypto";

/**
 * Content hash for an authored `fn` assertion predicate (research §7.4, ADR-003).
 *
 * The manifest carries no functions: the normalizer (P4) replaces each `fn` with a
 * stable `fnHash` marker, and the engine — the only runtime that holds the real
 * predicate — computes that hash here from the function source. Same source → same
 * hash, so a manifest entry can be matched back to its predicate at run time.
 */
export function hashFn(fn: (...args: never[]) => unknown): string {
  return `sha256:${createHash("sha256").update(fn.toString()).digest("hex")}`;
}
