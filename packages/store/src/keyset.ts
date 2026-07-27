import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * Shared keyset-paging plumbing for the Postgres stores. Both `tasks` and `runs` page the
 * same way — a `(timestamp, id)` keyset rendered into an opaque cursor — and this module is
 * the single copy of that, because two hand-maintained copies drifted apart the first time
 * they existed.
 */

/**
 * The sort key: a timestamp column rendered as fixed-width ISO-8601 UTC **text**.
 *
 * Text rather than the raw timestamptz because a cursor can only carry what it renders. The
 * column holds microseconds; the rendering holds milliseconds. Render on one side only and
 * the cursor lands *before* the row it came from, so every row sharing that millisecond
 * compares as after the boundary and is returned by no page at all — a silent, partial
 * listing. Selecting, ordering by, and comparing against this one expression is what makes
 * the cursor provably the same value the predicate uses.
 *
 * `to_char(…, 'MS')` truncates rather than rounds, so no separate `date_trunc` is needed —
 * and zero-padded UTC ISO sorts lexicographically in chronological order, so a text sort is
 * chronological.
 *
 * @param fallback substituted when the column is nullable, to keep the ordering total.
 */
export function isoSortKey(column: AnyColumn, fallback?: SQL): SQL<string> {
  const value = fallback ? sql`coalesce(${column}, ${fallback})` : sql`${column}`;
  return sql<string>`to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

/**
 * A cursor we did not mint. Typed rather than a plain `Error` so the MCP layer can classify
 * it as a *client* mistake: a bad cursor is the caller's, and reporting it as an internal
 * fault tells them the server broke when it did not.
 */
export class InvalidCursorError extends Error {
  constructor(readonly cursor: string) {
    super(`Invalid cursor "${cursor}"`);
    this.name = "InvalidCursorError";
  }
}

export interface KeysetCursor {
  /** The rendered sort key of the last row on the previous page. */
  sortKey: string;
  /** That row's unique id, which makes the composite key total. */
  tiebreaker: string;
}

/** Opaque per spec — a client must not parse, modify, or construct one. */
export function encodeKeysetCursor(sortKey: string, tiebreaker: string): string {
  return Buffer.from(JSON.stringify([sortKey, tiebreaker]), "utf8").toString("base64url");
}

/**
 * Decode a cursor, or `undefined` for the first page. Throws {@link InvalidCursorError} on
 * anything malformed rather than silently resetting to page 1 — which would make a paging
 * client loop forever over the first page instead of reporting the problem.
 */
export function decodeKeysetCursor(cursor?: string): KeysetCursor | undefined {
  if (cursor === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError(cursor);
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || typeof parsed[1] !== "string") {
    throw new InvalidCursorError(cursor);
  }
  return { sortKey: parsed[0], tiebreaker: parsed[1] };
}
