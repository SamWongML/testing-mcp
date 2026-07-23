import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool } from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Apply pending `*.sql` migrations in filename order, each in its own transaction, and
 * record them in a `_migrations` table so re-runs are no-ops. Deliberately in-house
 * (no drizzle-kit codegen): the DDL is hand-authored and small, and this keeps
 * "migrations apply cleanly to an empty database" fully under test with zero tooling.
 * Unqualified DDL lands in the connection's `search_path`, so a test can point the pool
 * at an isolated schema. Returns the names actually applied (empty when already current).
 */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const name of files) {
    const { rows } = await pool.query("SELECT 1 FROM _migrations WHERE name = $1", [name]);
    if (rows.length > 0) continue;
    const sql = await readFile(join(dir, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
    applied.push(name);
  }
  return applied;
}
