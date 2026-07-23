import type {
  AssertionOp,
  AssertionResult,
  AuthoredAssertion,
  DeclarativeAssertion,
} from "@atp/schema";

import type { EngineResponse } from "./context";
import { queryJsonPath } from "./jsonpath";
import { matchesJsonSchema } from "./jsonschema";
import { deepEqual, getByPath } from "./util";

/**
 * Assertion evaluation (research §10.2). Consumes *authored* assertions — the
 * declarative `{ path, op, value }` form and the `fn` escape hatch, which the
 * engine executes directly against the response `{ status, headers, body }`.
 */

function applyOp(op: AssertionOp, actual: unknown, expected: unknown): boolean {
  switch (op) {
    case "eq":
      return deepEqual(actual, expected);
    case "neq":
      return !deepEqual(actual, expected);
    case "gt":
    case "lt": {
      const a = Number(actual);
      const e = Number(expected);
      if (Number.isNaN(a) || Number.isNaN(e)) return false;
      return op === "gt" ? a > e : a < e;
    }
    case "contains":
      if (typeof actual === "string") return actual.includes(String(expected));
      if (Array.isArray(actual)) return actual.some((x) => deepEqual(x, expected));
      return false;
    case "matches":
      try {
        return new RegExp(String(expected)).test(String(actual));
      } catch {
        return false;
      }
    case "isString":
      return typeof actual === "string";
    case "isNumber":
      return typeof actual === "number";
    case "jsonSchema":
      return matchesJsonSchema(expected, actual);
    case "jsonpath":
      return false; // handled before applyOp (needs the whole response, not a scalar)
  }
}

function isFnAssertion(
  a: AuthoredAssertion,
): a is { fn: (res: unknown) => boolean; message?: string } {
  return "fn" in a && typeof a.fn === "function";
}

/** Evaluate one authored assertion against a response. */
export function evaluateAssertion(a: AuthoredAssertion, response: EngineResponse): AssertionResult {
  if (isFnAssertion(a)) {
    try {
      return { ok: Boolean(a.fn(response)), message: a.message };
    } catch (err) {
      return {
        ok: false,
        message: a.message ?? (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  const decl = a as DeclarativeAssertion;
  if (decl.op === "jsonpath") {
    const matches = queryJsonPath(decl.path, response);
    const actual = matches.length === 1 ? matches[0] : matches;
    const ok =
      decl.value === undefined ? matches.length > 0 : matches.some((m) => deepEqual(m, decl.value));
    return {
      ok,
      op: "jsonpath",
      path: decl.path,
      expected: decl.value,
      actual,
      message: decl.message,
    };
  }

  const actual = getByPath(response, decl.path);
  return {
    ok: applyOp(decl.op, actual, decl.value),
    op: decl.op,
    path: decl.path,
    expected: decl.value,
    actual,
    message: decl.message,
  };
}

/** Evaluate every assertion for a step, preserving order. */
export function evaluateAssertions(
  asserts: readonly AuthoredAssertion[],
  response: EngineResponse,
): AssertionResult[] {
  return asserts.map((a) => evaluateAssertion(a, response));
}
