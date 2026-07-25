import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DynamoIdempotencyStore } from "./dynamo-idempotency";
import { dynamoAvailable, makeTestTables, type TestTables } from "./test-aws";

describe.skipIf(!dynamoAvailable)("DynamoIdempotencyStore", () => {
  let tables: TestTables;
  let store: DynamoIdempotencyStore;
  beforeEach(async () => {
    tables = await makeTestTables();
    store = new DynamoIdempotencyStore({
      client: tables.client,
      tableName: tables.idempotencyTable,
    });
  });
  afterEach(async () => {
    await tables.close();
  });

  it("claims a key once — a repeat claim returns the original runId", async () => {
    const first = await store.claim("idem-1", "run-a");
    expect(first).toEqual({ runId: "run-a", claimed: true });

    // The resubmission's own candidate runId is discarded in favour of the winner's.
    const repeat = await store.claim("idem-1", "run-b");
    expect(repeat).toEqual({ runId: "run-a", claimed: false });
  });

  it("elects exactly one winner among concurrent claims", async () => {
    const candidates = ["run-1", "run-2", "run-3", "run-4", "run-5"];
    const results = await Promise.all(candidates.map((id) => store.claim("burst", id)));

    const winners = results.filter((r) => r.claimed);
    expect(winners).toHaveLength(1);
    // Every loser resolves to the winner's run id, so all five callers agree on one run.
    const winnerId = winners[0]!.runId;
    expect(results.every((r) => r.runId === winnerId)).toBe(true);
    expect(await store.get("burst")).toBe(winnerId);
  });

  it("returns null for an unclaimed key", async () => {
    expect(await store.get("never-claimed")).toBeNull();
  });
});
