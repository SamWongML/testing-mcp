import { deepEqual } from "./util";

/**
 * A minimal JSON Schema validator for the `jsonSchema` assertion operator
 * (research §10.2, "response-shape validation"). Supports the common subset —
 * `type`, `properties`, `required`, `items`, `enum`, `const` — recursively. It is
 * intentionally not a full draft implementation; richer needs use a `fn` assertion.
 */

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

/** True when `value` conforms to the (subset) JSON Schema `schema`. */
export function matchesJsonSchema(schema: unknown, value: unknown): boolean {
  if (!schema || typeof schema !== "object") return true;
  const s = schema as Record<string, unknown>;

  if (Array.isArray(s.enum) && !s.enum.some((e) => deepEqual(e, value))) return false;
  if ("const" in s && !deepEqual(s.const, value)) return false;

  if (typeof s.type === "string" && !matchesType(s.type, value)) return false;
  if (Array.isArray(s.type) && !s.type.some((t) => matchesType(String(t), value))) return false;

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(s.required)) {
      for (const r of s.required) if (!(String(r) in obj)) return false;
    }
    if (s.properties && typeof s.properties === "object") {
      for (const [k, sub] of Object.entries(s.properties as Record<string, unknown>)) {
        if (k in obj && !matchesJsonSchema(sub, obj[k])) return false;
      }
    }
  }

  if (Array.isArray(value) && s.items) {
    for (const item of value) if (!matchesJsonSchema(s.items, item)) return false;
  }

  return true;
}
