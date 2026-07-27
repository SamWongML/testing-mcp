import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestDb, pgAvailable, type TestDb } from "./db/test-db";
import { PostgresTaskStore } from "./tasks";

describe.skipIf(!pgAvailable)("PostgresTaskStore", () => {
  let tdb: TestDb;
  let store: PostgresTaskStore;
  beforeEach(async () => {
    tdb = await makeTestDb();
    store = new PostgresTaskStore(tdb.db);
  });
  afterEach(async () => {
    await tdb.close();
  });

  it("puts and gets a task", async () => {
    await store.put({ runId: "r1", state: "working", progressPct: 0 });
    const got = await store.get("r1");
    expect(got).toMatchObject({
      runId: "r1",
      state: "working",
      progressPct: 0,
      cancelRequested: false,
      currentNode: null,
    });
  });

  it("get returns null for an unknown run", async () => {
    expect(await store.get("nope")).toBeNull();
  });

  it("records createdAt on put and exposes it via get", async () => {
    await store.put({ runId: "r1", state: "working" });
    expect((await store.get("r1"))?.createdAt).toBeInstanceOf(Date);
  });

  it("create inserts once and returns null on a duplicate runId (idempotency primitive)", async () => {
    const first = await store.create({ runId: "r1", state: "working", ttlMs: 60_000 });
    expect(first).toMatchObject({ runId: "r1", state: "working" });
    expect(first?.createdAt).toBeInstanceOf(Date);

    // A second create for the same runId is a no-op → null, and must not disturb the row.
    const dup = await store.create({ runId: "r1", state: "failed", error: "should not apply" });
    expect(dup).toBeNull();
    expect(await store.get("r1")).toMatchObject({ state: "working", error: null });
  });

  it("put upserts (replaces) an existing task", async () => {
    await store.put({ runId: "r1", state: "working", progressPct: 10, currentNode: "a" });
    await store.put({ runId: "r1", state: "completed", resultRef: "run://r1/trace.json" });
    const got = await store.get("r1");
    expect(got?.state).toBe("completed");
    expect(got?.resultRef).toBe("run://r1/trace.json");
    expect(got?.currentNode).toBeNull(); // full replace clears prior fields
  });

  it("update patches only the provided fields", async () => {
    await store.put({ runId: "r1", state: "working", progressPct: 10, currentNode: "a" });
    const updated = await store.update("r1", { state: "failed", error: "boom" });
    expect(updated).toMatchObject({ state: "failed", error: "boom", progressPct: 10 });
    // currentNode untouched by the patch
    expect(updated?.currentNode).toBe("a");
  });

  it("update returns null for an absent task", async () => {
    expect(await store.update("ghost", { state: "completed" })).toBeNull();
  });

  it("setProgress advances progress without disturbing state", async () => {
    await store.put({ runId: "r1", state: "working" });
    await store.setProgress("r1", 50, "node-3");
    expect(await store.get("r1")).toMatchObject({
      state: "working",
      progressPct: 50,
      currentNode: "node-3",
    });

    // Omitting currentNode advances progress without clearing the prior node.
    await store.setProgress("r1", 75);
    expect(await store.get("r1")).toMatchObject({ progressPct: 75, currentNode: "node-3" });
  });

  it("requestCancel flags the task", async () => {
    await store.put({ runId: "r1", state: "working" });
    expect(await store.requestCancel("r1")).toBe(true);
    expect((await store.get("r1"))?.cancelRequested).toBe(true);
    expect(await store.requestCancel("missing")).toBe(false);
  });

  it("lists every task exactly once across cursor pages", async () => {
    // The traversal contract `tasks/list` rests on: anything `get` can return, a full
    // cursored walk must return — once. Five rows, pages of two, so the walk needs three
    // pages and the last one is short.
    const ids = ["r1", "r2", "r3", "r4", "r5"];
    for (const runId of ids) await store.create({ runId, state: "working" });

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ limit: 2, cursor });
      expect(page.tasks.length).toBeLessThanOrEqual(2);
      seen.push(...page.tasks.map((t) => t.runId));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen.slice().sort()).toEqual(ids);
  });

  it("does not skip tasks created within the same millisecond", async () => {
    // `created_at` is timestamptz — microseconds — while a cursor round-trips through a JS
    // Date, which is milliseconds. A keyset that encodes the truncated value lands *before*
    // the row it came from, so same-millisecond rows fall through the boundary and are never
    // returned by any page. Arranged by hand because natural timestamps only collide by luck.
    const micros = ["111", "222", "333", "444", "555"];
    for (const i of micros.keys()) await store.create({ runId: `r${i}`, state: "working" });
    for (const [i, us] of micros.entries()) {
      await tdb.db.execute(
        sql`UPDATE tasks SET created_at = ${`2026-07-27T01:00:00.004${us}+00`}::timestamptz WHERE run_id = ${`r${i}`}`,
      );
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list({ limit: 2, cursor });
      seen.push(...page.tasks.map((t) => t.runId));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen.slice().sort()).toEqual(["r0", "r1", "r2", "r3", "r4"]);
  });

  it("honors ttlMs and reaps only expired rows", async () => {
    await store.put({ runId: "fresh", state: "completed", ttlMs: 60_000 });
    await store.put({ runId: "stale", state: "completed", expiresAt: new Date(Date.now() - 1000) });
    await store.put({ runId: "no-ttl", state: "working" }); // never expires

    const fresh = await store.get("fresh");
    expect(fresh?.expiresAt).toBeInstanceOf(Date);
    expect(fresh!.expiresAt!.getTime()).toBeGreaterThan(Date.now());

    const removed = await store.deleteExpired();
    expect(removed).toBe(1);
    expect(await store.get("stale")).toBeNull();
    expect(await store.get("fresh")).not.toBeNull();
    expect(await store.get("no-ttl")).not.toBeNull();
  });
});
