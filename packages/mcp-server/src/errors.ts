import { InvalidCursorError } from "@atp/store";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { ScopeError } from "./auth";

/**
 * The error taxonomy. Before it, every failure was a plain `Error`, so "unknown id" and
 * "the server broke" were indistinguishable to a caller — and the *same* throw surfaced two
 * different ways: as `isError: true` text from a tool, but as JSON-RPC `-32603 InternalError`
 * from a resource read.
 *
 * One taxonomy, two renderings, because the protocol gives us no choice:
 *
 * - **Tools** cannot carry a JSON-RPC code. `McpServer` catches whatever a tool handler
 *   throws — `McpError` included — and flattens it to `{ content: [text], isError: true }`,
 *   discarding the code (`server/mcp.js`). So the machine code rides in `structuredContent`
 *   instead, which the SDK passes through untouched.
 * - **Resources** propagate a thrown `McpError` as a real JSON-RPC error, so there the code
 *   is the wire-level one.
 *
 * Message text is never rewritten by either path: it is what non-structured clients read,
 * and several tests assert on it.
 */

/**
 * The stable, machine-readable codes. Additive like the rest of the surface — a new code may
 * be added, but an existing one never changes meaning, so a client can branch on it.
 */
export type AtpErrorCode =
  | "not_found" // no entry/run with that id
  | "invalid_argument" // well-formed request, unusable argument (wrong kind, bad cursor)
  | "forbidden" // authenticated, but missing the required scope
  | "unavailable" // a capability this deployment isn't configured for (e.g. no run db)
  | "internal"; // anything unclassified — a real fault

/** An error carrying a taxonomy code alongside its client-facing message. */
export class AtpError extends Error {
  constructor(
    readonly code: AtpErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AtpError";
  }
}

export const notFound = (message: string): AtpError => new AtpError("not_found", message);
export const invalidArgument = (message: string): AtpError =>
  new AtpError("invalid_argument", message);
export const unavailable = (message: string): AtpError => new AtpError("unavailable", message);

/** Classify any thrown value. Unrecognized throws are `internal` — the honest default, since
 * the alternative is reporting a genuine fault as a client mistake. */
export function classify(err: unknown): { code: AtpErrorCode; message: string } {
  if (err instanceof AtpError) return { code: err.code, message: err.message };
  // A scope failure is already modelled by the auth layer; map it rather than re-throwing a
  // second error type for the same condition.
  if (err instanceof ScopeError) return { code: "forbidden", message: err.message };
  // Same reasoning for a bad cursor: the store owns that validation (it mints the cursors),
  // but it is unambiguously the *caller's* mistake. Without this branch it falls to the
  // catch-all and `list_runs` reports a client typo as a server fault.
  if (err instanceof InvalidCursorError) return { code: "invalid_argument", message: err.message };
  return { code: "internal", message: err instanceof Error ? err.message : String(err) };
}

/** The tool rendering: an `isError` result whose `structuredContent.error` carries the code.
 * `content` keeps the bare message, unchanged from what the SDK used to produce. */
export function errorResult(err: unknown): CallToolResult {
  const { code, message } = classify(err);
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { error: { code, message } },
    isError: true,
  };
}

/** JSON-RPC codes for the resource rendering. The protocol has no "not found", and the spec
 * uses `InvalidParams` for an unresolvable request parameter — which is what an unknown id in
 * a URI is. Only a genuine fault earns `InternalError`. */
const RPC_CODE: Record<AtpErrorCode, ErrorCode> = {
  not_found: ErrorCode.InvalidParams,
  invalid_argument: ErrorCode.InvalidParams,
  forbidden: ErrorCode.InvalidRequest,
  unavailable: ErrorCode.InvalidRequest,
  internal: ErrorCode.InternalError,
};

/** The resource rendering: a real JSON-RPC error. The taxonomy code travels in `data` so a
 * structured client gets the same machine code it would from a tool. */
export function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  const { code, message } = classify(err);
  return new McpError(RPC_CODE[code], message, { code });
}

/**
 * Wrap a tool handler so its throws become typed error results. Applied at registration so
 * every tool renders failures identically — a handler that throws an `AtpError` anywhere in
 * its call stack (including inside `@atp/engine`) gets the taxonomy for free.
 */
export function toolErrors<A extends unknown[]>(
  handler: (...args: A) => CallToolResult | Promise<CallToolResult>,
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A): Promise<CallToolResult> => {
    try {
      return await handler(...args);
    } catch (err) {
      return errorResult(err);
    }
  };
}

/** Wrap a resource handler so its throws become typed JSON-RPC errors instead of a blanket
 * `InternalError`. */
export function resourceErrors<A extends unknown[], R>(
  handler: (...args: A) => R | Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args: A): Promise<R> => {
    try {
      return await handler(...args);
    } catch (err) {
      throw toMcpError(err);
    }
  };
}
