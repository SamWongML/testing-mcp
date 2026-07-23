import { executionResultSchema } from "@atp/schema";
import { describe, expect, it } from "vitest";

import { allFixtures } from "./fixtures";

// The fixtures are hand-authored; guard that each still models a real `ExecutionResult`
// so a renderer never renders a shape the engine could not actually produce.
describe("reporting fixtures", () => {
  for (const [name, result] of Object.entries(allFixtures)) {
    it(`${name} satisfies executionResultSchema`, () => {
      expect(() => executionResultSchema.parse(result)).not.toThrow();
    });
  }
});
