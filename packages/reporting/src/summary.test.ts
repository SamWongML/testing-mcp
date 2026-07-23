import { describe, expect, it } from "vitest";

import { allFixtures, failingSuite, passingTest } from "./fixtures";
import { renderSummary } from "./summary";

describe("renderSummary (llm_summary)", () => {
  it("a passing run is a single compact line", () => {
    const out = renderSummary(passingTest);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out).toContain("identity.login");
    expect(out).toContain("passed");
    expect(out).toContain("1/1 steps");
    expect(out).toContain("2/2 assertions");
  });

  it("a failing run reports what failed, the likely cause, and a next action", () => {
    const out = renderSummary(failingSuite);
    expect(out).toContain("failed");
    expect(out).toContain("verify");
    expect(out.toLowerCase()).toContain("likely cause");
    expect(out).toContain("assertion-failed");
    expect(out.toLowerCase()).toContain("next action");
  });

  for (const [name, result] of Object.entries(allFixtures)) {
    it(`golden: ${name}`, async () => {
      await expect(renderSummary(result)).toMatchFileSnapshot(`__snapshots__/${name}.summary.txt`);
    });
  }
});
