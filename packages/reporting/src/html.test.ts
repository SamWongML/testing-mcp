import { describe, expect, it } from "vitest";

import { allFixtures, failingSuite, passingTest } from "./fixtures";
import { renderHtml } from "./html";

describe("renderHtml", () => {
  it("is a self-contained document (doctype, inline style, no external refs)", () => {
    const out = renderHtml(passingTest);
    expect(out).toContain("<!DOCTYPE html>");
    expect(out).toContain("<style>");
    // Self-contained: no external stylesheet/script/font references.
    expect(out).not.toMatch(/<link[^>]+href=/i);
    expect(out).not.toMatch(/<script[^>]+src=/i);
    expect(out).not.toContain("http://cdn");
  });

  it("shows the entry id and status", () => {
    const out = renderHtml(passingTest);
    expect(out).toContain("identity.login");
    expect(out).toContain("passed");
  });

  it("puts each request/response trace in an expandable <details>", () => {
    const out = renderHtml(passingTest);
    expect(out).toContain("<details");
    expect(out).toContain("<summary");
  });

  it("escapes dynamic content (no raw angle brackets from data leak into markup)", () => {
    const out = renderHtml(
      // A body value containing HTML must be escaped, not rendered as a tag.
      { ...passingTest, steps: passingTest.steps.map((s) => ({ ...s, id: "<script>x</script>" })) },
    );
    expect(out).not.toContain("<script>x</script>");
    expect(out).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  it("surfaces the likely cause for a failing run", () => {
    const out = renderHtml(failingSuite);
    expect(out.toLowerCase()).toContain("likely cause");
    expect(out).toContain("assertion-failed");
  });

  for (const [name, result] of Object.entries(allFixtures)) {
    it(`golden: ${name}`, async () => {
      await expect(renderHtml(result)).toMatchFileSnapshot(`__snapshots__/${name}.report.html`);
    });
  }
});
