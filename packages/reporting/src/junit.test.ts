import { describe, expect, it } from "vitest";

import { allFixtures, cancelledRun, failingSuite, passingTest } from "./fixtures";
import { renderJUnit } from "./junit";

describe("renderJUnit", () => {
  it("emits a testsuites/testsuite wrapper with per-step counts", () => {
    const out = renderJUnit(failingSuite);
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(out).toContain('<testsuite name="billing.e2e-refund"');
    expect(out).toContain('tests="4"');
    expect(out).toContain('failures="1"');
    expect(out).toContain('skipped="1"');
  });

  it("a passing run has no failure/error elements", () => {
    const out = renderJUnit(passingTest);
    expect(out).not.toContain("<failure");
    expect(out).not.toContain("<error");
  });

  it("a failed step becomes a <failure> with an escaped message", () => {
    const out = renderJUnit(failingSuite);
    expect(out).toContain('<testcase name="verify"');
    expect(out).toContain("<failure");
    // The expected/actual values are XML-escaped (quotes → &quot;).
    expect(out).toContain("&quot;");
    expect(out).not.toContain('message=""settled""');
  });

  it("cancelled steps map to <skipped> (JUnit has no cancelled state)", () => {
    const out = renderJUnit(cancelledRun);
    expect(out).toContain("<skipped");
    expect(out).toContain('message="cancelled"');
  });

  for (const [name, result] of Object.entries(allFixtures)) {
    it(`golden: ${name}`, async () => {
      await expect(renderJUnit(result)).toMatchFileSnapshot(`__snapshots__/${name}.junit.xml`);
    });
  }
});
