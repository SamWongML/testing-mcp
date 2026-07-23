import { describe, expect, it } from "vitest";

import { allFixtures, failingSuite, passingTest } from "./fixtures";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("headlines the entry id and status", () => {
    const out = renderMarkdown(passingTest);
    expect(out).toContain("# Report — identity.login");
    expect(out).toContain("**Status:** passed");
  });

  it("renders a per-step table with attempts and timing", () => {
    const out = renderMarkdown(passingTest);
    expect(out).toContain("| Step | Status | Attempts | Time |");
    expect(out).toContain("login");
    expect(out).toContain("42ms");
  });

  it("a passing run has no failures section", () => {
    const out = renderMarkdown(passingTest);
    expect(out).not.toContain("## Failures");
    expect(out).not.toContain("## Likely cause");
  });

  it("a failing run details the failed assertion and the likely cause", () => {
    const out = renderMarkdown(failingSuite);
    expect(out).toContain("## Likely cause");
    expect(out).toContain("assertion-failed");
    expect(out).toContain("## Failures");
    expect(out).toContain("### verify");
    expect(out).toContain("`eq`");
    expect(out).toContain("$.state");
    expect(out).toContain("settled");
    expect(out).toContain("pending");
  });

  for (const [name, result] of Object.entries(allFixtures)) {
    it(`golden: ${name}`, async () => {
      await expect(renderMarkdown(result)).toMatchFileSnapshot(`__snapshots__/${name}.report.md`);
    });
  }
});
