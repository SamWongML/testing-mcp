import type {
  AuthoredStep,
  AuthoredSuite,
  AuthoredTestCase,
  UseStepNode,
  UseTestNode,
} from "@atp/schema";

import type { AuthProvider } from "./context";

/**
 * Authoring entry points (research §7.1 / §7.2). `defineTest`/`defineSuite`/`defineEnv`
 * are typed identity functions: they keep the authored, function-carrying form intact
 * (the `params` builder and `fn` predicates the normalizer will later hash) while giving
 * IDE/type checking at authoring time. They also run cheap structural guards so obvious
 * mistakes fail fast where they're written, not at run time. `useTest`/`useStep` are the
 * by-reference composition helpers (research §12: reference, never copy).
 */
export function defineTest<T extends AuthoredTestCase>(test: T): T {
  if (!test.id || typeof test.id !== "string") {
    throw new Error("defineTest: `id` must be a non-empty string");
  }
  if (!Number.isInteger(test.version) || test.version <= 0) {
    throw new Error(`defineTest(${test.id}): \`version\` must be a positive integer`);
  }
  if (!Array.isArray(test.steps) || test.steps.length === 0) {
    throw new Error(`defineTest(${test.id}): must declare at least one step`);
  }
  return test;
}

/** Typed identity for a reusable environment object (`{{env.*}}` source). */
export function defineEnv<T extends Record<string, unknown>>(env: T): T {
  return env;
}

/**
 * Typed identity + guard for a hand-written auth provider (the `custom` escape hatch;
 * the `bearer`/`basic`/`api-key`/`oauth2` factories in `auth.ts` cover the common cases).
 * Lives alongside a suite's other reusable building blocks in `tests/_shared/auth`.
 */
export function defineAuth<T extends AuthProvider>(provider: T): T {
  if (!provider.id || typeof provider.id !== "string") {
    throw new Error("defineAuth: `id` must be a non-empty string");
  }
  if (typeof provider.apply !== "function") {
    throw new Error(`defineAuth(${provider.id}): must provide an \`apply\` function`);
  }
  return provider;
}

/** A suite composes tests/steps into a DAG (research §7.2 / §12). */
export function defineSuite<T extends AuthoredSuite>(suite: T): T {
  if (!suite.id || typeof suite.id !== "string") {
    throw new Error("defineSuite: `id` must be a non-empty string");
  }
  if (!Number.isInteger(suite.version) || suite.version <= 0) {
    throw new Error(`defineSuite(${suite.id}): \`version\` must be a positive integer`);
  }
  if (!suite.nodes || Object.keys(suite.nodes).length === 0) {
    throw new Error(`defineSuite(${suite.id}): must declare at least one node`);
  }
  return suite;
}

/** Compose an existing test into a suite node, optionally overriding its params. */
export function useTest(
  test: AuthoredTestCase,
  opts: { params?: Record<string, unknown>; needs?: string[] } = {},
): UseTestNode {
  return { use: "test", test, params: opts.params, needs: opts.needs };
}

/** Compose a shared step into a suite node, binding its inputs via `with`. */
export function useStep(
  step: AuthoredStep,
  opts: { with?: Record<string, unknown>; needs?: string[] } = {},
): UseStepNode {
  return { use: "step", step, with: opts.with, needs: opts.needs };
}
