import { type ExecutionResult, executionResultSchema } from "@atp/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestDb, pgAvailable, type TestDb } from "./db/test-db";
import { getRun, listRuns, recordRun } from "./runs";

function makeResult(over: Partial<ExecutionResult> = {}): ExecutionResult {
  return executionResultSchema.parse({
    runId: "run-1",
    entryId: "identity.login",
    kind: "test",
    status: "passed",
    startedAt: "2026-07-05T10:00:00.000Z",
    finishedAt: "2026-07-05T10:00:01.500Z",
    durationMs: 1500.7,
    steps: [
      {
        id: "login",
        status: "passed",
        timingMs: 42.4,
        attempts: 1,
        assertions: [
          { ok: true, op: "eq", path: "status", message: "status is 200" },
          { ok: true, op: "isString", path: "$.token" },
        ],
      },
    ],
    metrics: { totalSteps: 1, passedSteps: 1, failedSteps: 0 },
    manifestHash: "sha256:abc",
    gitSha: "deadbeef",
    ...over,
  });
}

describe.skipIf(!pgAvailable)("runs", () => {
  let tdb: TestDb;
  beforeEach(async () => {
    tdb = await makeTestDb();
  });
  afterEach(async () => {
    await tdb.close();
  });

  it("records a run with its steps and assertions in one transaction", async () => {
    await recordRun(tdb.db, makeResult(), { invokedBy: "agent-1", artifactUri: "file:///a/run-1" });

    const detail = await getRun(tdb.db, "run-1");
    expect(detail).not.toBeNull();
    expect(detail!.run).toMatchObject({
      id: "run-1",
      entryId: "identity.login",
      status: "passed",
      env: null,
      durationMs: 1501, // float rounded to int
      manifestHash: "sha256:abc",
      invokedBy: "agent-1",
      artifactUri: "file:///a/run-1",
    });
    expect(detail!.run.startedAt).toBeInstanceOf(Date);

    expect(detail!.steps).toHaveLength(1);
    expect(detail!.steps[0]).toMatchObject({
      nodeId: "login",
      status: "passed",
      timingMs: 42, // rounded
      attempts: 1,
    });

    expect(detail!.assertions).toHaveLength(2);
    const byIdx = [...detail!.assertions].sort((a, b) => a.idx - b.idx);
    expect(byIdx.map((a) => [a.idx, a.ok, a.message])).toEqual([
      [0, true, "status is 200"],
      [1, true, null], // assertion with no message → null
    ]);
  });

  it("getRun returns null for an unknown run", async () => {
    expect(await getRun(tdb.db, "ghost")).toBeNull();
  });

  it("lists runs newest-first, filtered by entryId / status / since", async () => {
    await recordRun(
      tdb.db,
      makeResult({
        runId: "r-old",
        entryId: "identity.login",
        status: "passed",
        startedAt: "2026-07-01T00:00:00.000Z",
      }),
    );
    await recordRun(
      tdb.db,
      makeResult({
        runId: "r-new",
        entryId: "identity.login",
        status: "failed",
        startedAt: "2026-07-10T00:00:00.000Z",
      }),
    );
    await recordRun(
      tdb.db,
      makeResult({
        runId: "r-other",
        entryId: "billing.refund",
        status: "passed",
        startedAt: "2026-07-11T00:00:00.000Z",
      }),
    );

    // Newest-first across all.
    expect((await listRuns(tdb.db)).map((r) => r.id)).toEqual(["r-other", "r-new", "r-old"]);

    // By entry.
    expect((await listRuns(tdb.db, { entryId: "identity.login" })).map((r) => r.id)).toEqual([
      "r-new",
      "r-old",
    ]);

    // By status.
    expect((await listRuns(tdb.db, { status: "failed" })).map((r) => r.id)).toEqual(["r-new"]);

    // By recency.
    expect(
      (await listRuns(tdb.db, { since: new Date("2026-07-05T00:00:00.000Z") })).map((r) => r.id),
    ).toEqual(["r-other", "r-new"]);

    // Limit.
    expect((await listRuns(tdb.db, { limit: 1 })).map((r) => r.id)).toEqual(["r-other"]);
  });
});
