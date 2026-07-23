import type { RunContext } from "./context";
import { getBySegments } from "./util";

/**
 * `{{scope.path}}` template resolution against a scoped `RunContext` (research §10.2).
 *
 * Scopes: `env`, `params`, `secrets`, `matrix`, `vars`, `nodes` (`nodes.X.var`).
 * Two substitution modes:
 *  - **whole-value** — a string that is exactly one template (`"{{params.count}}"`)
 *    resolves to the raw value, preserving its type (number, object, …).
 *  - **interpolation** — templates embedded in text (`"{{env.baseUrl}}/login"`)
 *    are stringified in place.
 * Resolution is recursive (bounded): a value that is itself a template — e.g. a
 * param default of `"{{secrets.QA_PASSWORD}}"` — is resolved again.
 */

const FULL_TEMPLATE = /^\{\{\s*([^}]+?)\s*\}\}$/;
const TEMPLATE_G = /\{\{\s*([^}]+?)\s*\}\}/g;
const HAS_TEMPLATE = /\{\{[^}]*\}\}/;
const MAX_DEPTH = 16;

function lookup(expr: string, ctx: RunContext): unknown {
  const [scope, ...rest] = expr.trim().split(".");
  const root =
    scope === "nodes"
      ? ctx.nodes
      : scope === "env"
        ? ctx.env
        : scope === "params"
          ? ctx.params
          : scope === "secrets"
            ? ctx.secrets
            : scope === "matrix"
              ? ctx.matrix
              : scope === "vars"
                ? ctx.vars
                : undefined;
  if (root === undefined) {
    throw new Error(`unknown template scope "${scope ?? ""}" in {{${expr.trim()}}}`);
  }
  return getBySegments(root, rest);
}

function required(expr: string, ctx: RunContext): unknown {
  const value = lookup(expr, ctx);
  if (value === undefined) {
    throw new Error(`unresolved template variable {{${expr.trim()}}}`);
  }
  return value;
}

function resolveString(input: string, ctx: RunContext, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    throw new Error(`template recursion too deep near "${input}"`);
  }
  const full = FULL_TEMPLATE.exec(input);
  if (full) {
    const value = required(full[1] as string, ctx);
    if (typeof value === "string" && HAS_TEMPLATE.test(value)) {
      return resolveString(value, ctx, depth + 1);
    }
    return value;
  }
  const replaced = input.replace(TEMPLATE_G, (_m, expr: string) => String(required(expr, ctx)));
  if (replaced !== input && HAS_TEMPLATE.test(replaced)) {
    return resolveString(replaced, ctx, depth + 1);
  }
  return replaced;
}

function resolveValue(value: unknown, ctx: RunContext): unknown {
  if (typeof value === "string") return resolveString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, ctx);
    return out;
  }
  return value;
}

/** Deeply resolve every `{{…}}` template in `value` against the context. */
export function resolveTemplates<T>(value: T, ctx: RunContext): T {
  return resolveValue(value, ctx) as T;
}

/** Build a `RunContext`, defaulting every scope so template lookups never crash. */
export function createRunContext(init: Partial<RunContext> = {}): RunContext {
  return {
    env: init.env ?? {},
    params: init.params ?? {},
    secrets: init.secrets ?? {},
    matrix: init.matrix ?? {},
    nodes: init.nodes ?? {},
    vars: init.vars ?? {},
    signal: init.signal,
  };
}
