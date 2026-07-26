import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claim, type StoreClient } from "@atp/store";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import type { ServerContext } from "./context";
import { cancelRun, getRun, getRunResult, submitRun } from "./tasks";
import {
  connectClient,
  makeTestContext,
  makeTestDb,
  pgAvailable,
  startTestSut,
  type ConnectedClient,
  type TestSut,
} from "./testkit";
import { claimAndRun, reapOnce, startWorker, sweepExpiredTasks } from "./worker";

/** Poll `fn` until it returns truthy or the deadline passes (integration timing helper). */
async function waitFor<T>(fn: () => Promise<T>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * async lifecycle — end-to-end over Postgres. Gated on
 * `ATP_TEST_DATABASE_URL`; skips offline (same posture as the `@atp/store` suite). Each test
 * drives the durable queue + task store through submit → worker → terminal → fetch.
 */
describe.skipIf(!pgAvailable)("async run lifecycle", () => {
  let store: StoreClient;
  let ctx: ServerContext;
  let sut: TestSut;

  beforeEach(async () => {
    store = await makeTestDb();
    ctx = await makeTestContext({ db: store.db });
    sut = await startTestSut();
  });
  afterEach(async () => {
    await sut.close();
    await store.close();
  });

  it("submit → worker → completed, with a fetchable report", async () => {
    const { runId, state } = await submitRun(ctx, {
      entryId: "alpha.widget-lifecycle",
      env: { baseUrl: sut.url },
    });
    expect(state).toBe("working");

    const ran = await claimAndRun(ctx, "worker-1");
    expect(ran).toBe(true);

    const task = await getRun(ctx, runId);
    expect(task?.state).toBe("completed");
    expect(task?.progressPct).toBe(100);

    const result = await getRunResult(ctx, runId);
    expect(result.ready).toBe(true);
    expect(result.result?.status).toBe("passed");
    expect(result.result?.kind).toBe("suite");
  });

  it("dedupes a resubmission by idempotency key — one run, one job", async () => {
    const key = "idem-key-1";
    const first = await submitRun(ctx, {
      entryId: "alpha.create-widget",
      env: { baseUrl: sut.url },
      idempotencyKey: key,
    });
    const second = await submitRun(ctx, {
      entryId: "alpha.create-widget",
      env: { baseUrl: sut.url },
      idempotencyKey: key,
    });
    expect(second.runId).toBe(first.runId);
    expect(second.deduped).toBe(true);

    // Exactly one job was enqueued: the first claim runs it, the second finds nothing.
    expect(await claimAndRun(ctx, "w")).toBe(true);
    expect(await claimAndRun(ctx, "w")).toBe(false);
  });

  it("cancel before the worker claims → finalized cancelled, and get_run_result is clean (no trace)", async () => {
    const { runId } = await submitRun(ctx, {
      entryId: "alpha.widget-lifecycle",
      env: { baseUrl: sut.url },
    });
    expect(await cancelRun(ctx, runId)).toBe(true);

    await claimAndRun(ctx, "worker-1");
    expect((await getRun(ctx, runId))?.state).toBe("cancelled");

    // This terminal path never executed, so no trace was persisted: the result must come back
    // ready-but-empty (state cancelled), not throw a misleading "no run" error.
    const res = await getRunResult(ctx, runId);
    expect(res).toMatchObject({ state: "cancelled", ready: true });
    expect(res.result).toBeUndefined();
  });

  it("unknown-entry job → failed with the diagnostic surfaced through get_run_result", async () => {
    // submitRun does not validate the entry (the worker does), so an unknown id enqueues a job
    // that the worker fails via finalizeError — with no trace but a real error message.
    const { runId } = await submitRun(ctx, { entryId: "no.such.entry" });
    await claimAndRun(ctx, "worker-1");

    const task = await getRun(ctx, runId);
    expect(task?.state).toBe("failed");
    expect(task?.error).toContain("no.such.entry");

    const res = await getRunResult(ctx, runId);
    expect(res).toMatchObject({ state: "failed", ready: true });
    expect(res.result).toBeUndefined();
    expect(res.error).toContain("no.such.entry");
  });

  it("cancel mid-run → the worker aborts the in-flight suite and finalizes cancelled", async () => {
    // Ledger never settles, so the `verify` node polls — the window to cancel mid-run.
    const slowSut = await startTestSut({ ledgerSettles: false });
    try {
      const { runId } = await submitRun(ctx, {
        entryId: "alpha.widget-lifecycle",
        env: { baseUrl: slowSut.url },
      });
      // Run the job concurrently with a fast cancel-poll cadence.
      const running = claimAndRun(ctx, "worker-1", { heartbeatMs: 50 });
      // Wait until the chain has reached the polling `verify` node (2/3 settled).
      await waitFor(async () => ((await getRun(ctx, runId))?.progressPct ?? 0) >= 60);
      expect(await cancelRun(ctx, runId)).toBe(true);
      await running;
      expect((await getRun(ctx, runId))?.state).toBe("cancelled");
    } finally {
      await slowSut.close();
    }
  });

  it("crash mid-run → the reaper requeues the lease and a second worker completes it", async () => {
    const { runId } = await submitRun(ctx, {
      entryId: "alpha.widget-lifecycle",
      env: { baseUrl: sut.url },
    });

    // Worker A claims the job then "crashes" — no heartbeat, no completion.
    const claimed = await claim(store.db, "worker-A");
    expect(claimed?.runId).toBe(runId);

    // The reaper requeues leases older than the (here, zero) lease budget.
    expect(await reapOnce(ctx, 0)).toBe(1);

    // Worker B picks up the requeued job and finishes it.
    expect(await claimAndRun(ctx, "worker-B")).toBe(true);
    expect((await getRun(ctx, runId))?.state).toBe("completed");
  });

  it("non-Task client path: run_selection + get_run + get_run_result via the MCP tools", async () => {
    let conn: ConnectedClient | undefined;
    const worker = startWorker(ctx, { pollMs: 20, heartbeatMs: 50 });
    try {
      conn = await connectClient(ctx);
      const sel = (await conn.client.callTool({
        name: "run_selection",
        arguments: { query: "alpha.create-widget", env: { baseUrl: sut.url } },
      })) as unknown as { structuredContent: { runs: { runId: string }[] } };
      const runId = sel.structuredContent.runs[0]!.runId;

      // Poll get_run until terminal, then fetch the rendered report.
      await waitFor(async () => {
        const r = (await conn!.client.callTool({
          name: "get_run",
          arguments: { runId },
        })) as unknown as { structuredContent: { run: { state: string } } };
        return r.structuredContent.run.state === "completed";
      });

      const report = (await conn.client.callTool({
        name: "get_run_result",
        arguments: { runId, format: "md" },
      })) as unknown as { content: { text?: string }[]; structuredContent: { ready: boolean } };
      expect(report.structuredContent.ready).toBe(true);
      expect(report.content.map((c) => c.text ?? "").join("")).toContain("alpha.create-widget");
    } finally {
      await worker.stop();
      await conn?.close();
    }
  });

  it("Task client path: run_suite via the SEP-1686 Tasks extension (callToolStream)", async () => {
    let conn: ConnectedClient | undefined;
    const worker = startWorker(ctx, { pollMs: 20, heartbeatMs: 50 });
    try {
      conn = await connectClient(ctx);
      const stream = conn.client.experimental.tasks.callToolStream(
        {
          name: "run_suite",
          arguments: { id: "alpha.widget-lifecycle", env: { baseUrl: sut.url } },
        },
        undefined,
        { task: { ttl: 60_000 } },
      );

      let taskId: string | undefined;
      let final: { structuredContent?: { status?: string } } | undefined;
      for await (const msg of stream) {
        if (msg.type === "taskCreated") taskId = msg.task.taskId;
        if (msg.type === "result") final = msg.result as typeof final;
      }
      expect(taskId).toBeDefined();
      expect(final?.structuredContent?.status).toBe("passed");

      // The same run is fetchable via the extension's tasks/get + tasks/result.
      const t = await conn.client.experimental.tasks.getTask(taskId!);
      expect(t.status).toBe("completed");
      const res = await conn.client.experimental.tasks.getTaskResult(taskId!, CallToolResultSchema);
      expect((res.structuredContent as { status?: string }).status).toBe("passed");
    } finally {
      await worker.stop();
      await conn?.close();
    }
  });

  it("sweeps terminal tasks past their TTL, leaving live ones alone", async () => {
    // SEP-1686 retains a result "for a server-defined duration"; without a sweep the rows
    // accumulate forever. Live and un-expired tasks must survive it.
    const expired = await submitRun(ctx, {
      entryId: "alpha.create-widget",
      env: { baseUrl: sut.url },
      ttlMs: -1000,
    });
    const live = await submitRun(ctx, {
      entryId: "alpha.create-widget",
      env: { baseUrl: sut.url },
    });

    expect(await sweepExpiredTasks(ctx)).toBe(1);
    expect(await getRun(ctx, expired.runId)).toBeNull();
    expect(await getRun(ctx, live.runId)).not.toBeNull();
  });

  it("a one-shot worker drains exactly one job and exits (the RunTask escape hatch)", async () => {
    const first = await submitRun(ctx, {
      entryId: "alpha.create-widget",
      env: { baseUrl: sut.url },
    });
    const second = await submitRun(ctx, {
      entryId: "alpha.create-widget",
      env: { baseUrl: sut.url },
    });

    // This is the mode an `ecs:RunTask`-launched task runs in: claim one job, finish it, exit.
    // Without the self-stop it would be a second, unmanaged worker pool that never scales in.
    const worker = startWorker(ctx, { pollMs: 20, heartbeatMs: 50, maxRuns: 1 });
    await worker.done;

    const states = await Promise.all(
      [first.runId, second.runId].map(async (id) => (await getRun(ctx, id))?.state),
    );
    expect(states.filter((s) => s === "completed")).toHaveLength(1);
    expect(states.filter((s) => s === "working")).toHaveLength(1);
  });
});
