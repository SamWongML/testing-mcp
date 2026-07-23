import { describe, expect, it } from "vitest";

import { formatList, formatResult, listEntries, runById, validate } from "./commands";

// The CLI commands operate on the real sample corpus at the repo root (cwd during tests).

describe("listEntries", () => {
  it("lists the whole corpus, id-sorted", async () => {
    const entries = await listEntries();
    expect(entries.map((e) => e.id)).toEqual([
      "billing.e2e-refund",
      "billing.get-invoice",
      "identity.login",
    ]);
  });

  it("filters by tag", async () => {
    const entries = await listEntries({ tags: ["billing"] });
    expect(entries.map((e) => e.id).sort()).toEqual(["billing.e2e-refund", "billing.get-invoice"]);
  });

  it("filters by kind and owner", async () => {
    expect((await listEntries({ kind: "suite" })).map((e) => e.id)).toEqual(["billing.e2e-refund"]);
    expect((await listEntries({ owner: "team-identity" })).map((e) => e.id)).toEqual([
      "identity.login",
    ]);
  });
});

describe("validate", () => {
  it("reports the corpus compiles", async () => {
    expect((await validate()).entries).toBe(3);
  });
});

describe("runById", () => {
  it("runs a single test against the local mock SUT and passes", async () => {
    const result = await runById("identity.login");
    expect(result.status).toBe("passed");
    expect(result.entryId).toBe("identity.login");
    expect(result.metrics.failedAssertions).toBe(0);
    // The run records provenance (research §21).
    expect(result.manifestHash).toMatch(/^sha256:/);
  });

  it("runs the billing invoice test and passes", async () => {
    expect((await runById("billing.get-invoice")).status).toBe("passed");
  });

  it("runs the composed suite end-to-end (DAG + poll + cross-file reuse) and passes", async () => {
    const result = await runById("billing.e2e-refund");
    expect(result.kind).toBe("suite");
    expect(result.status).toBe("passed");
    expect(result.steps.map((s) => s.id)).toEqual(["auth", "order", "capture", "refund", "verify"]);
    expect(result.steps.every((s) => s.status === "passed")).toBe(true);
  });

  it("throws a helpful error for an unknown id", async () => {
    await expect(runById("does.not.exist")).rejects.toThrow(/unknown test id/);
  });
});

describe("formatting", () => {
  it("formatList renders one line per entry with id, kind, and tags", async () => {
    const text = formatList(await listEntries());
    expect(text).toContain("identity.login");
    expect(text).toContain("suite");
    expect(text).toContain("billing");
  });

  it("formatResult summarizes status and steps", async () => {
    const text = formatResult(await runById("identity.login"));
    expect(text).toContain("identity.login");
    expect(text).toContain("passed");
  });
});
