import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { migrate } from "./migrate";
import { makeTestDb, pgAvailable, type TestDb } from "./test-db";

/** The migrations on disk, in the order `migrate()` applies them. Read rather than
 * hardcoded: the invariant under test is "every migration applies and re-running is a
 * no-op", not "there are exactly N of them" — which would fail on each new one. */
async function migrationFiles(): Promise<string[]> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");
  return (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
}

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
        "run_checkpoints",
      ]),
    );
  });

  it("records every migration and is idempotent on re-run", async () => {
    tdb = await makeTestDb();
    const { rows } = await tdb.pool.query<{ name: string }>(
      `SELECT name FROM _migrations ORDER BY name`,
    );
    expect(rows.map((r) => r.name)).toEqual(await migrationFiles());

    const appliedAgain = await migrate(tdb.pool);
    expect(appliedAgain).toEqual([]);
  });
});
