import { randomUUID } from "node:crypto";

import { Pool } from "pg";

import { createStore, type StoreClient } from "./client";
import { migrate } from "./migrate";

/**
 * Integration-test harness. Real Postgres is required and provided out-of-band via
 * `ATP_TEST_DATABASE_URL` (docker-compose.dev.yml, a CI service, or a local cluster);
 * when it is unset the integration suites skip so `pnpm test` stays green without a DB.
 *
 * Each `makeTestDb()` creates a throwaway Postgres *schema* (namespace) and points the
 * pool's `search_path` at it, so every suite gets a private, migrated set of tables and
 * concurrent claim tests share one database via a real connection pool. `close()` drops
 * the schema.
 */
export const TEST_DATABASE_URL = process.env.ATP_TEST_DATABASE_URL;
export const pgAvailable = Boolean(TEST_DATABASE_URL);

export interface TestDb extends StoreClient {
  /** The isolated Postgres namespace these tables live in. */
  namespace: string;
}

export async function makeTestDb(): Promise<TestDb> {
  const url = TEST_DATABASE_URL;
  if (!url) throw new Error("ATP_TEST_DATABASE_URL is not set");
  const namespace = `atp_test_${randomUUID().replace(/-/g, "")}`;

  const admin = new Pool({ connectionString: url });
  try {
    await admin.query(`CREATE SCHEMA "${namespace}"`);
  } finally {
    await admin.end();
  }

  const store = createStore({ connectionString: url, options: `-c search_path=${namespace}` });
  await migrate(store.pool);

  return {
    ...store,
    namespace,
    async close() {
      await store.close();
      const cleanup = new Pool({ connectionString: url });
      try {
        await cleanup.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      } finally {
        await cleanup.end();
      }
    },
  };
}
