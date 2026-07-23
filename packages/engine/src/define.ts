import type { AuthoredTestCase } from "@atp/schema";

/**
 * Authoring entry points (research §7.1). `defineTest` and `defineEnv` are typed
 * identity functions: they keep the authored, function-carrying form intact (the
 * `params` builder and `fn` predicates the normalizer will later hash) while giving
 * IDE/type checking at authoring time. `defineTest` also runs cheap structural
 * guards so obvious mistakes fail fast where they're written, not at run time.
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
