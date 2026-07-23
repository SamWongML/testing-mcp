import { z } from "zod";

import type { ParamsBuilder } from "./test";

/**
 * Zod → JSON Schema derivation for a test's `params` (research §7.1, ADR-003).
 *
 * `describe_test` (P7) and the manifest's `paramsSchema` both rely on this: the
 * authored, function-built Zod object becomes a serializable JSON Schema that an
 * MCP client can render as a tool input schema.
 */

/** A JSON Schema document, kept permissive (draft-2020-12 as emitted by Zod). */
export const jsonSchemaSchema = z.record(z.string(), z.unknown());
export type JsonSchema = z.infer<typeof jsonSchemaSchema>;

/** Convert any Zod schema to a JSON Schema document. */
export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema) as JsonSchema;
}

/**
 * Run an authored params builder and derive its JSON Schema.
 *
 * Uses `io: "input"` so a param with a `.default()` is optional in the derived
 * schema — an MCP client may omit it and let the engine supply the default. This is
 * the tool *input* schema `describe_test` (P7) advertises.
 */
export function deriveParamsSchema(builder: ParamsBuilder): JsonSchema {
  return z.toJSONSchema(builder(z), { io: "input" }) as JsonSchema;
}
