import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listAudit, recordAudit } from "./audit";
import { makeTestDb, pgAvailable, type TestDb } from "./db/test-db";

/**
 * The audit log: who invoked which run with which params and scopes,
 * fed by the OAuth identity. pg-gated — skips offline like the rest of the store suite.
 */
describe.skipIf(!pgAvailable)("audit log", () => {
  let tdb: TestDb;
  beforeEach(async () => {
    tdb = await makeTestDb();
  });
  afterEach(async () => {
    await tdb.close();
  });

  it("records an audit entry and reads it back", async () => {
    await recordAudit(tdb.db, {
      principal: "agent-7",
      action: "run_test",
      entryId: "identity.login",
      params: { username: "u1" },
      scopes: ["test:read", "test:run"],
    });

    const rows = await listAudit(tdb.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      principal: "agent-7",
      action: "run_test",
      entryId: "identity.login",
      params: { username: "u1" },
      scopes: ["test:read", "test:run"],
    });
    expect(rows[0]!.at).toBeInstanceOf(Date);
  });

  it("defaults optional fields to null when omitted", async () => {
    await recordAudit(tdb.db, { principal: "anonymous", action: "run_selection" });
    const [row] = await listAudit(tdb.db);
    expect(row).toMatchObject({ principal: "anonymous", action: "run_selection" });
    expect(row!.entryId).toBeNull();
    expect(row!.params).toBeNull();
    expect(row!.scopes).toBeNull();
  });

  it("lists newest-first, filterable by principal and entry", async () => {
    await recordAudit(tdb.db, { principal: "a", action: "run_test", entryId: "identity.login" });
    await recordAudit(tdb.db, {
      principal: "b",
      action: "run_suite",
      entryId: "billing.e2e-refund",
    });
    await recordAudit(tdb.db, {
      principal: "a",
      action: "run_test",
      entryId: "billing.e2e-refund",
    });

    // Newest-first: the bigserial id tiebreaks equal timestamps deterministically.
    const all = await listAudit(tdb.db);
    expect(all.map((r) => r.principal)).toEqual(["a", "b", "a"]);

    expect((await listAudit(tdb.db, { principal: "a" })).every((r) => r.principal === "a")).toBe(
      true,
    );
    expect(await listAudit(tdb.db, { principal: "a" })).toHaveLength(2);
    expect(
      (await listAudit(tdb.db, { entryId: "billing.e2e-refund" })).map((r) => r.principal),
    ).toEqual(["a", "b"]);
    expect(await listAudit(tdb.db, { limit: 1 })).toHaveLength(1);
  });
});
