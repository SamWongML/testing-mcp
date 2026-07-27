import type { StepResult } from "@atp/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getCheckpoints,
  pruneCheckpoints,
  putCheckpoint,
  sweepExpiredCheckpoints,
} from "./checkpoints";
import { makeTestDb, pgAvailable, type TestDb } from "./db/test-db";

function step(id: string, over: Partial<StepResult> = {}): StepResult {
  return { id, status: "passed", assertions: [], extracted: {}, attempts: 1, ...over };
}

describe.skipIf(!pgAvailable)("run checkpoints", () => {
  let tdb: TestDb;
  beforeEach(async () => {
    tdb = await makeTestDb();
  });
  afterEach(async () => {
    await tdb.close();
  });

  it("round-trips a settled node, keyed by node id", async () => {
    await putCheckpoint(tdb.db, {
      runId: "run-1",
      nodeId: "order",
      payload: step("order", { extracted: { paymentId: "pay-1" } }),
    });
    await putCheckpoint(tdb.db, { runId: "run-1", nodeId: "capture", payload: step("capture") });

    const seeds = await getCheckpoints(tdb.db, "run-1");
    expect(Object.keys(seeds).sort()).toEqual(["capture", "order"]);
    // The extracted bag is what a resumed attempt rehydrates for downstream templates.
    expect(seeds.order?.extracted).toEqual({ paymentId: "pay-1" });
  });

  it("upserts on (runId, nodeId) rather than duplicating the node", async () => {
    await putCheckpoint(tdb.db, { runId: "run-1", nodeId: "order", payload: step("order") });
    await putCheckpoint(tdb.db, {
      runId: "run-1",
      nodeId: "order",
      payload: step("order", { status: "failed" }),
    });

    const seeds = await getCheckpoints(tdb.db, "run-1");
    expect(Object.keys(seeds)).toEqual(["order"]);
    expect(seeds.order?.status).toBe("failed");
  });

  it("returns an empty seed for a run that has never checkpointed", async () => {
    expect(await getCheckpoints(tdb.db, "unknown")).toEqual({});
  });

  it("prunes strictly by run, leaving other runs' checkpoints intact", async () => {
    await putCheckpoint(tdb.db, { runId: "run-1", nodeId: "a", payload: step("a") });
    await putCheckpoint(tdb.db, { runId: "run-2", nodeId: "a", payload: step("a") });

    expect(await pruneCheckpoints(tdb.db, "run-1")).toBe(1);
    expect(await getCheckpoints(tdb.db, "run-1")).toEqual({});
    expect(Object.keys(await getCheckpoints(tdb.db, "run-2"))).toEqual(["a"]);
  });

  it("sweeps only rows older than the cutoff", async () => {
    await putCheckpoint(tdb.db, { runId: "old", nodeId: "a", payload: step("a") });
    await tdb.pool.query(`UPDATE run_checkpoints SET created_at = now() - interval '2 days'`);
    await putCheckpoint(tdb.db, { runId: "fresh", nodeId: "a", payload: step("a") });

    expect(await sweepExpiredCheckpoints(tdb.db, 60 * 60 * 1000)).toBe(1);
    expect(await getCheckpoints(tdb.db, "old")).toEqual({});
    expect(Object.keys(await getCheckpoints(tdb.db, "fresh"))).toEqual(["a"]);
  });
});
