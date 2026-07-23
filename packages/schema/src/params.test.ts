import { describe, expect, it } from "vitest";
import { z } from "zod";

import { deriveParamsSchema, jsonSchemaSchema, zodToJsonSchema } from "./params";

describe("deriveParamsSchema", () => {
  it("derives a JSON Schema from an authored params builder (§7.1)", () => {
    const jsonSchema = deriveParamsSchema((z) =>
      z.object({
        email: z.string().email().default("qa@example.com"),
        password: z.string().default("{{secrets.QA_PASSWORD}}"),
      }),
    );
    expect(jsonSchema.type).toBe("object");
    const properties = jsonSchema.properties as Record<
      string,
      { type?: string; default?: unknown }
    >;
    expect(properties.email?.type).toBe("string");
    expect(properties.email?.default).toBe("qa@example.com");
    // A param with a default is optional in the tool input schema (client may omit it).
    expect((jsonSchema.required as string[] | undefined) ?? []).not.toContain("email");
    // The derived JSON Schema is itself a valid manifest paramsSchema value.
    expect(() => jsonSchemaSchema.parse(jsonSchema)).not.toThrow();
  });

  it("keeps a param without a default required", () => {
    const jsonSchema = deriveParamsSchema((z) => z.object({ id: z.string() }));
    expect(jsonSchema.required).toEqual(["id"]);
  });
});

describe("zodToJsonSchema", () => {
  it("converts a bare Zod schema", () => {
    const jsonSchema = zodToJsonSchema(z.object({ n: z.number().int() }));
    const properties = jsonSchema.properties as Record<string, { type?: string }>;
    expect(properties.n?.type).toBe("integer");
  });
});
