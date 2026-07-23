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
    const got = await store.get("r1");
    expect(got).toMatchObject({ state: "working", progressPct: 50, currentNode: "node-3" });
  });

  it("requestCancel flags the task", async () => {
    await store.put({ runId: "r1", state: "working" });
    expect(await store.requestCancel("r1")).toBe(true);
    expect((await store.get("r1"))?.cancelRequested).toBe(true);
    expect(await store.requestCancel("missing")).toBe(false);
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
