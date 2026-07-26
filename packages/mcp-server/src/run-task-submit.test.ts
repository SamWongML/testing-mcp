import { claim, type StoreClient } from "@atp/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerContext } from "./context";
import type { RunTaskLauncher } from "./run-task";
import { submitRun } from "./tasks";
import { makeTestContext, makeTestDb, pgAvailable } from "./testkit";

/** Records launches and can be made to fail, so the degradation path is testable. */
function recordingLauncher(fail = false): RunTaskLauncher & { launched: string[] } {
  const launched: string[] = [];
  return {
    launched,
    launch: async (runId: string) => {
      launched.push(runId);
      if (fail) throw new Error("ecs:RunTask failed: RESOURCE:MEMORY");
      return `arn:aws:ecs:::task/${runId}`;
    },
  };
}

/**
 * The mode-2 wiring: an isolated submission still goes through the durable queue and
 * *additionally* launches a dedicated Fargate task. The queue-first ordering is the whole
 * safety property — it is what makes the escape hatch an optimisation rather than a second,
 * fragile execution path.
 */
describe.skipIf(!pgAvailable)("isolated run submission", () => {
  let store: StoreClient;
  let ctx: ServerContext;
  let launcher: ReturnType<typeof recordingLauncher>;

  beforeEach(async () => {
    store = await makeTestDb();
    launcher = recordingLauncher();
    ctx = await makeTestContext({ db: store.db, runTaskLauncher: launcher });
  });
  afterEach(async () => {
    await store.close();
  });

  it("enqueues the job and launches a dedicated task when isolated", async () => {
    const { runId } = await submitRun(ctx, { entryId: "identity.login", isolated: true });

    expect(launcher.launched).toEqual([runId]);
    // Still queued: the pool remains the backstop if the one-off task never starts.
    expect((await claim(store.db, "pool-worker"))?.runId).toBe(runId);
  });

  it("does not launch for an ordinary submission", async () => {
    await submitRun(ctx, { entryId: "identity.login" });
    expect(launcher.launched).toEqual([]);
  });

  it("degrades to the worker pool when the launch fails", async () => {
    ctx = await makeTestContext({ db: store.db, runTaskLauncher: recordingLauncher(true) });
    // A capacity/throttle failure must not fail the submission — the run is already durable.
    const { runId, state } = await submitRun(ctx, { entryId: "identity.login", isolated: true });

    expect(state).toBe("working");
    expect((await claim(store.db, "pool-worker"))?.runId).toBe(runId);
  });
});
