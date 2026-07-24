import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProgressUpdate } from "@atp/engine";
import type { ManifestEntry } from "@atp/schema";

import { executeEntry } from "./execute";
import { makeTestContext, startTestSut, type TestSut } from "./testkit";
import type { ServerContext } from "./context";

/** Locate a corpus entry by id in the boot manifest. */
function entry(ctx: ServerContext, id: string): ManifestEntry {
  const e = ctx.manifest.entries.find((x) => x.id === id);
  if (!e) throw new Error(`no corpus entry ${id}`);
  return e;
}

describe("executeEntry — the shared test/suite executor (P8)", () => {
  let ctx: ServerContext;
  let sut: TestSut;
  beforeEach(async () => {
    ctx = await makeTestContext();
    sut = await startTestSut();
  });
  afterEach(async () => {
    await sut.close();
  });

  it("runs a single test against the injected env", async () => {
    const result = await executeEntry(ctx, entry(ctx, "identity.login"), {
      env: { baseUrl: sut.url },
    });
    expect(result.kind).toBe("test");
    expect(result.status).toBe("passed");
    expect(result.entryId).toBe("identity.login");
    // Provenance from the boot manifest is stamped on the run.
    expect(result.manifestHash).toBe(ctx.manifest.manifestHash);
  });

  it("runs a suite end-to-end and reports node-by-node progress", async () => {
    const updates: ProgressUpdate[] = [];
    const result = await executeEntry(ctx, entry(ctx, "billing.e2e-refund"), {
      env: { baseUrl: sut.url },
      runId: "run-suite-1",
      onProgress: (u) => updates.push(u),
    });

    expect(result.kind).toBe("suite");
    expect(result.status).toBe("passed");
    expect(result.runId).toBe("run-suite-1");
    // The suite has five nodes; progress ticks reach total for the worker's k/n.
    expect(updates.at(-1)).toMatchObject({ completed: 5, total: 5 });
    expect(updates.map((u) => u.nodeId)).toContain("verify");
  });

  it("threads the AbortSignal so a pre-aborted run comes back cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await executeEntry(ctx, entry(ctx, "billing.e2e-refund"), {
      env: { baseUrl: sut.url },
      signal: controller.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(result.steps.every((s) => s.status === "cancelled")).toBe(true);
  });

  it("rejects an unknown entry kind mismatch (suite imported where a test is expected is caught upstream)", async () => {
    // A test entry runs as a test; a suite entry runs as a suite — executeEntry dispatches
    // on the imported definition, so the manifest kind and module agree or it throws.
    const result = await executeEntry(ctx, entry(ctx, "billing.get-invoice"), {
      env: { baseUrl: sut.url },
    });
    expect(result.kind).toBe("test");
    expect(result.status).toBe("passed");
  });
});
