import { executionResultSchema } from "@atp/schema";
import { describe, expect, it } from "vitest";

import { allFixtures, failingSuite } from "./fixtures";
import { renderTrace } from "./trace";

describe("renderTrace", () => {
  it("is full-fidelity JSON that round-trips through the schema", () => {
    const out = renderTrace(failingSuite);
    const parsed = executionResultSchema.parse(JSON.parse(out));
    // A persisted result is canonical (schema defaults applied), so the round-trip is
    // measured against the canonical form of the fixture, not the sparse literal.
    expect(parsed).toEqual(executionResultSchema.parse(failingSuite));
  });

  it("is pretty-printed (indented, multi-line)", () => {
    const out = renderTrace(failingSuite);
    expect(out).toContain("\n");
    expect(out).toContain('  "runId"');
  });

  for (const [name, result] of Object.entries(allFixtures)) {
    it(`golden: ${name}`, async () => {
      await expect(renderTrace(result)).toMatchFileSnapshot(`__snapshots__/${name}.trace.json`);
    });
  }
});
