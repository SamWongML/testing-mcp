import { describe, expect, it } from "vitest";

import { SCHEMA_PACKAGE } from "./index";

describe("@atp/schema", () => {
  it("exposes its package name", () => {
    expect(SCHEMA_PACKAGE).toBe("@atp/schema");
  });
});
