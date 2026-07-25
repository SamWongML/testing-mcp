import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DynamoTaskStore } from "./dynamo-tasks";
import { dynamoAvailable, makeTestTables, type TestTables } from "./test-aws";

describe.skipIf(!dynamoAvailable)("DynamoTaskStore", () => {
  let tables: TestTables;
  let store: DynamoTaskStore;
  beforeEach(async () => {
    tables = await makeTestTables();
    store = new DynamoTaskStore({ client: tables.client, tableName: tables.tasksTable });
  });
  afterEach(async () => {
    await tables.close();
  });

  it("puts and gets a task", async () => {
    await store.put({ runId: "r1", state: "working", progressPct: 0 });
    expect(await store.get("r1")).toMatchObject({
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

  it("create inserts once and returns null on a duplicate runId (idempotency primitive)", async () => {
    const first = await store.create({ runId: "r1", state: "working", ttlMs: 60_000 });
    expect(first).toMatchObject({ runId: "r1", state: "working" });
    expect(first?.createdAt).toBeInstanceOf(Date);

    // A second create for the same runId is a no-op → null, and must not disturb the row.
    const dup = await store.create({ runId: "r1", state: "failed", error: "should not apply" });
    expect(dup).toBeNull();
    expect(await store.get("r1")).toMatchObject({ state: "working", error: null });
  });

  it("put upserts (replaces) an existing task but preserves createdAt", async () => {
    const created = await store.put({
      runId: "r1",
      state: "working",
      progressPct: 10,
      currentNode: "a",
    });
    await store.put({ runId: "r1", state: "completed", resultRef: "run://r1/trace.json" });

    const got = await store.get("r1");
    expect(got?.state).toBe("completed");
    expect(got?.resultRef).toBe("run://r1/trace.json");
    expect(got?.currentNode).toBeNull(); // full replace clears prior fields
    // SEP-1686 `Task.createdAt` is when the task was *first* created — a replace must not
    // reset it (the Postgres store preserves it via the insert-only column default).
    expect(got?.createdAt.toISOString()).toBe(created.createdAt.toISOString());
  });

  it("update patches only the provided fields", async () => {
    await store.put({ runId: "r1", state: "working", progressPct: 10, currentNode: "a" });
    const updated = await store.update("r1", { state: "failed", error: "boom" });
    expect(updated).toMatchObject({ state: "failed", error: "boom", progressPct: 10 });
    expect(updated?.currentNode).toBe("a"); // untouched by the patch
  });

  it("update returns null for an absent task", async () => {
    expect(await store.update("ghost", { state: "completed" })).toBeNull();
    // …and must not have conjured the item into existence.
    expect(await store.get("ghost")).toBeNull();
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

  it("honors ttlMs and reaps only expired items", async () => {
    await store.put({ runId: "fresh", state: "completed", ttlMs: 60_000 });
    await store.put({ runId: "stale", state: "completed", expiresAt: new Date(Date.now() - 1000) });
    await store.put({ runId: "no-ttl", state: "working" }); // never expires

    const fresh = await store.get("fresh");
    expect(fresh?.expiresAt).toBeInstanceOf(Date);
    expect(fresh!.expiresAt!.getTime()).toBeGreaterThan(Date.now());

    expect(await store.deleteExpired()).toBe(1);
    expect(await store.get("stale")).toBeNull();
    expect(await store.get("fresh")).not.toBeNull();
    expect(await store.get("no-ttl")).not.toBeNull();
  });
});
