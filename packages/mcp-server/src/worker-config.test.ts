import { loadConfig } from "@atp/schema";
import { describe, expect, it } from "vitest";

import { workerOptionsFromConfig } from "./worker";

/**
 * The env → `WorkerOptions` mapping. This seam exists because the §11.3 mode-2 escape hatch
 * is only real if the environment the `ecs:RunTask` launcher sets is actually *read*: the
 * launcher writes `WORKER_ONCE`/`ATP_RUN_ID` onto the one-off task, and nothing else connects
 * them to the worker loop's `maxRuns`/`runId`. Testing `startWorker({ maxRuns: 1 })` directly
 * proves the mechanism but not the wiring — which is exactly how this shipped broken.
 */
describe("workerOptionsFromConfig", () => {
  it("leaves a pooled worker unbounded", () => {
    const opts = workerOptionsFromConfig(loadConfig({}));
    expect(opts.maxRuns).toBeUndefined();
    expect(opts.runId).toBeUndefined();
    expect(opts.idleTimeoutMs).toBeUndefined();
  });

  it("bounds a WORKER_ONCE task to a single run", () => {
    const opts = workerOptionsFromConfig(loadConfig({ WORKER_ONCE: "true" }));
    // Without this the launched Fargate task loops forever, claiming from the shared queue,
    // unregistered with the worker service and so never scaled in.
    expect(opts.maxRuns).toBe(1);
    // …and it must not wait forever for work that may already have been taken by the pool.
    expect(opts.idleTimeoutMs).toBeGreaterThan(0);
  });

  it("targets the run it was launched for", () => {
    const opts = workerOptionsFromConfig(
      loadConfig({ WORKER_ONCE: "true", ATP_RUN_ID: "run-abc" }),
    );
    expect(opts.runId).toBe("run-abc");
  });
});
