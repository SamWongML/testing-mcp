import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestDb, pgAvailable, type TestDb } from "./db/test-db";
import {
  claim,
  enqueue,
  heartbeat,
  isCancelRequested,
  markDone,
  reapExpired,
  requestCancel,
} from "./queue";

describe.skipIf(!pgAvailable)("queue", () => {
  let tdb: TestDb;
  beforeEach(async () => {
    tdb = await makeTestDb();
  });
  afterEach(async () => {
    await tdb.close();
  });

  it("enqueues a job as queued and claims it as running", async () => {
    const job = await enqueue(tdb.db, { runId: "run-1", spec: { entryId: "identity.login" } });
    expect(job.status).toBe("queued");
    expect(job.runId).toBe("run-1");

    const claimed = await claim(tdb.db, "worker-a");
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.workerId).toBe("worker-a");
    expect(claimed?.claimedAt).toBeInstanceOf(Date);

    // Queue now empty.
    expect(await claim(tdb.db, "worker-a")).toBeNull();
  });

  it("respects priority then age", async () => {
    await enqueue(tdb.db, { runId: "low", priority: 0 });
    await enqueue(tdb.db, { runId: "high", priority: 10 });
    await enqueue(tdb.db, { runId: "mid", priority: 5 });

    expect((await claim(tdb.db, "w"))?.runId).toBe("high");
    expect((await claim(tdb.db, "w"))?.runId).toBe("mid");
    expect((await claim(tdb.db, "w"))?.runId).toBe("low");
  });

  it("does not become available until run_after", async () => {
    await enqueue(tdb.db, { runId: "later", runAfter: new Date(Date.now() + 60_000) });
    expect(await claim(tdb.db, "w")).toBeNull();
  });

  it("claims each job exactly once under concurrency (no double-claim)", async () => {
    const N = 8;
    for (let i = 0; i < N; i++) await enqueue(tdb.db, { runId: `run-${i}` });

    // More claimers than jobs, all contending at once.
    const results = await Promise.all(
      Array.from({ length: N + 4 }, (_, i) => claim(tdb.db, `worker-${i}`)),
    );

    const claimed = results.filter((r): r is NonNullable<typeof r> => r !== null);
    const ids = claimed.map((c) => c.id);
    expect(ids.length).toBe(N); // every job claimed
    expect(new Set(ids).size).toBe(N); // and each exactly once
    expect(results.filter((r) => r === null).length).toBe(4); // surplus claimers got nothing
  });

  it("reaper requeues a job whose lease expired, and it can be re-claimed", async () => {
    await enqueue(tdb.db, { runId: "crashed" });
    const claimed = await claim(tdb.db, "dead-worker");
    expect(claimed).not.toBeNull();

    // Simulate a worker that died an hour ago.
    await tdb.pool.query(`UPDATE jobs SET claimed_at = now() - interval '1 hour'`);

    const requeued = await reapExpired(tdb.db, 60_000); // 1-minute lease
    expect(requeued.map((j) => j.runId)).toEqual(["crashed"]);
    expect(requeued[0]?.status).toBe("queued");
    expect(requeued[0]?.workerId).toBeNull();

    const reclaimed = await claim(tdb.db, "fresh-worker");
    expect(reclaimed?.runId).toBe("crashed");
    expect(reclaimed?.workerId).toBe("fresh-worker");
  });

  it("heartbeat keeps a live job's lease fresh so the reaper skips it", async () => {
    await enqueue(tdb.db, { runId: "alive" });
    const claimed = await claim(tdb.db, "worker-a");
    const jobId = claimed!.id;

    // Age the claim, then heartbeat to refresh it to now().
    await tdb.pool.query(`UPDATE jobs SET claimed_at = now() - interval '1 hour'`);
    expect(await heartbeat(tdb.db, jobId, "worker-a")).toBe(true);

    expect(await reapExpired(tdb.db, 60_000)).toEqual([]); // fresh lease → not reaped

    // A stale worker id cannot heartbeat someone else's job.
    expect(await heartbeat(tdb.db, jobId, "other-worker")).toBe(false);
  });

  it("markDone removes a job from reaper eligibility", async () => {
    await enqueue(tdb.db, { runId: "finished" });
    const claimed = await claim(tdb.db, "worker-a");
    await tdb.pool.query(`UPDATE jobs SET claimed_at = now() - interval '1 hour'`);

    await markDone(tdb.db, claimed!.id, "done");
    expect(await reapExpired(tdb.db, 60_000)).toEqual([]); // done → never requeued
  });

  it("cancel flag is set per run and observable by the worker", async () => {
    const job = await enqueue(tdb.db, { runId: "to-cancel" });
    expect(await isCancelRequested(tdb.db, job.id)).toBe(false);

    expect(await requestCancel(tdb.db, "to-cancel")).toBe(true);
    expect(await isCancelRequested(tdb.db, job.id)).toBe(true);

    // No matching run → nothing flagged.
    expect(await requestCancel(tdb.db, "nonexistent")).toBe(false);
  });
});
