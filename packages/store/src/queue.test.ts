import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestDb, pgAvailable, type TestDb } from "./db/test-db";
import {
  claim,
  enqueue,
  heartbeat,
  isCancelRequested,
  markDone,
  queueDepth,
  reapExpired,
  requestCancel,
  sweepTerminalJobs,
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

  it("counts each lease expiry and backs off before the job is claimable again", async () => {
    await enqueue(tdb.db, { runId: "flaky" });
    await claim(tdb.db, "worker-a");
    await tdb.pool.query(`UPDATE jobs SET claimed_at = now() - interval '1 hour'`);

    // First expiry: counted, but retried immediately — a single crash is usually a one-off.
    const first = await reapExpired(tdb.db, 60_000);
    expect(first[0]?.attempts).toBe(1);
    expect(await claim(tdb.db, "worker-b")).not.toBeNull();

    // Second expiry: counted again, and now spaced out.
    await tdb.pool.query(`UPDATE jobs SET claimed_at = now() - interval '1 hour'`);
    const second = await reapExpired(tdb.db, 60_000);
    expect(second[0]?.attempts).toBe(2);
    expect(second[0]?.status).toBe("queued");
    expect(second[0]?.runAfter.getTime()).toBeGreaterThan(Date.now());
    // Not claimable until the backoff elapses.
    expect(await claim(tdb.db, "worker-c")).toBeNull();
  });

  it("dead-letters a job that exhausts its attempts instead of requeuing it forever", async () => {
    await enqueue(tdb.db, { runId: "poison", maxAttempts: 1 });
    const claimed = await claim(tdb.db, "worker-a");
    expect(claimed?.maxAttempts).toBe(1);
    await tdb.pool.query(`UPDATE jobs SET claimed_at = now() - interval '1 hour'`);

    const [reaped] = await reapExpired(tdb.db, 60_000);
    expect(reaped?.status).toBe("dead_letter");
    expect(reaped?.attempts).toBe(1);
    expect(reaped?.lastError).toContain("dead-lettered");
    // Frozen for forensics: the worker that lost it is still recorded.
    expect(reaped?.workerId).toBe("worker-a");

    // Terminal: never claimable again, so it stops consuming worker slots.
    expect(await claim(tdb.db, "worker-b")).toBeNull();
    expect(await claim(tdb.db, "worker-b", { runId: "poison" })).toBeNull();
  });

  it("stamps first_claimed_at once and preserves it across a reap and re-claim", async () => {
    await enqueue(tdb.db, { runId: "resumed" });
    const first = await claim(tdb.db, "worker-a");
    expect(first?.firstClaimedAt).toBeInstanceOf(Date);

    await tdb.pool.query(`UPDATE jobs SET claimed_at = now() - interval '1 hour'`);
    await reapExpired(tdb.db, 60_000);
    const second = await claim(tdb.db, "worker-b");

    // The re-claim refreshes the lease but not the run's original start.
    expect(second?.firstClaimedAt?.getTime()).toBe(first?.firstClaimedAt?.getTime());
    expect(second?.claimedAt?.getTime()).not.toBe(first?.claimedAt?.getTime());
  });

  it("sweeps settled jobs past their retention window, never live ones", async () => {
    // Nothing removed a settled row before, so every job's `spec` payload accumulated in the
    // table the claim path scans. History and traces are elsewhere and untouched.
    await enqueue(tdb.db, { runId: "old-done" });
    const claimed = await claim(tdb.db, "worker-a");
    await markDone(tdb.db, claimed!.id, "worker-a", "done");
    await tdb.pool.query(`UPDATE jobs SET created_at = now() - interval '30 days'`);
    await enqueue(tdb.db, { runId: "still-queued" });

    expect(await sweepTerminalJobs(tdb.db, 7 * 24 * 60 * 60 * 1000)).toBe(1);
    const { rows } = await tdb.pool.query<{ run_id: string }>(`SELECT run_id FROM jobs`);
    expect(rows.map((r) => r.run_id)).toEqual(["still-queued"]);
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

  it("markDone (done|failed) removes a job from reaper eligibility", async () => {
    await enqueue(tdb.db, { runId: "finished" });
    const claimed = await claim(tdb.db, "worker-a");
    await tdb.pool.query(`UPDATE jobs SET claimed_at = now() - interval '1 hour'`);

    expect(await markDone(tdb.db, claimed!.id, "worker-a", "failed")).toBe(true);
    expect(await reapExpired(tdb.db, 60_000)).toEqual([]); // terminal → never requeued
    // A terminal job can no longer be heartbeated.
    expect(await heartbeat(tdb.db, claimed!.id, "worker-a")).toBe(false);
  });

  it("markDone is guarded: a stale worker cannot finalize a reassigned job", async () => {
    await enqueue(tdb.db, { runId: "reassigned" });
    const first = await claim(tdb.db, "worker-a"); // A claims, then stalls
    await tdb.pool.query(`UPDATE jobs SET claimed_at = now() - interval '1 hour'`);
    await reapExpired(tdb.db, 60_000); // reaper requeues it
    const second = await claim(tdb.db, "worker-b"); // B claims the same job
    expect(second?.id).toBe(first!.id);

    // A resumes and tries to finalize — must be rejected (B still owns it, running).
    expect(await markDone(tdb.db, first!.id, "worker-a")).toBe(false);
    const [row] = await tdb.pool
      .query<{ status: string; worker_id: string }>(
        `SELECT status, worker_id FROM jobs WHERE id = $1`,
        [first!.id],
      )
      .then((r) => r.rows);
    expect(row).toMatchObject({ status: "running", worker_id: "worker-b" });
  });

  it("queueDepth counts ready queued jobs — the worker-autoscaling signal", async () => {
    expect(await queueDepth(tdb.db)).toBe(0);

    await enqueue(tdb.db, { runId: "q1" });
    await enqueue(tdb.db, { runId: "q2" });
    await enqueue(tdb.db, { runId: "q3" });
    expect(await queueDepth(tdb.db)).toBe(3);

    // A claimed job is `running`, not queued → depth drops.
    await claim(tdb.db, "worker-a");
    expect(await queueDepth(tdb.db)).toBe(2);

    // A future-scheduled job is queued but not yet ready → excluded from the depth.
    await enqueue(tdb.db, { runId: "later", runAfter: new Date(Date.now() + 60_000) });
    expect(await queueDepth(tdb.db)).toBe(2);
  });

  it("cancel flag is set per run and observable by the worker", async () => {
    const job = await enqueue(tdb.db, { runId: "to-cancel" });
    expect(await isCancelRequested(tdb.db, job.id)).toBe(false);
    // A running job can still be flagged for cancellation.
    await claim(tdb.db, "worker-a");

    expect(await requestCancel(tdb.db, "to-cancel")).toBe(true);
    expect(await isCancelRequested(tdb.db, job.id)).toBe(true);

    // No matching run → nothing flagged; unknown job id → not cancelled.
    expect(await requestCancel(tdb.db, "nonexistent")).toBe(false);
    expect(await isCancelRequested(tdb.db, "no-such-job")).toBe(false);
  });

  it("claims a specific run when targeted, ignoring higher-priority work", async () => {
    // The mode-2 one-off task exists to give *one particular* run a dedicated
    // container. An untargeted claim would let it pick up whatever is at the head of the
    // queue instead — the beefy isolated task running a trivial job while the long run it
    // was launched for goes to a pooled worker.
    await enqueue(tdb.db, { runId: "other", priority: 10 });
    await enqueue(tdb.db, { runId: "mine", priority: 0 });

    const claimed = await claim(tdb.db, "one-shot", { runId: "mine" });
    expect(claimed?.runId).toBe("mine");

    // The untargeted job is untouched and still claimable by the pool.
    expect((await claim(tdb.db, "pool"))?.runId).toBe("other");
  });

  it("returns null when the targeted run is no longer claimable", async () => {
    await enqueue(tdb.db, { runId: "taken" });
    expect((await claim(tdb.db, "pool"))?.runId).toBe("taken");
    // A pooled worker got there first: the one-shot task must not block or steal it.
    expect(await claim(tdb.db, "one-shot", { runId: "taken" })).toBeNull();
  });
});
