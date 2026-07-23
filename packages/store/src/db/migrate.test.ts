import { afterEach, describe, expect, it } from "vitest";

import { migrate } from "./migrate";
import { makeTestDb, pgAvailable, type TestDb } from "./test-db";

describe.skipIf(!pgAvailable)("migrations", () => {
  let tdb: TestDb | undefined;
  afterEach(async () => {
    await tdb?.close();
    tdb = undefined;
  });

  it("applies cleanly to an empty database, creating every table", async () => {
    tdb = await makeTestDb(); // makeTestDb() runs migrate() on a fresh empty schema
    const { rows } = await tdb.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
      [tdb.namespace],
    );
    const names = rows.map((r) => r.table_name);
    expect(names).toEqual(
      expect.arrayContaining([
        "manifests",
        "catalog_entries",
        "jobs",
        "runs",
        "step_results",
        "assertion_results",
        "audit_log",
        "tasks",
      ]),
    );
  });

  it("records the migration and is idempotent on re-run", async () => {
    tdb = await makeTestDb();
    const { rows } = await tdb.pool.query<{ name: string }>(
      `SELECT name FROM _migrations ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual(["0000_init.sql"]);

    const appliedAgain = await migrate(tdb.pool);
    expect(appliedAgain).toEqual([]);
  });
});
