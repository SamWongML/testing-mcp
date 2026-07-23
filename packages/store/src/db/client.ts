import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

import * as schema from "./schema";

/** The typed Drizzle handle over the store schema. */
export type Db = NodePgDatabase<typeof schema>;

export interface StoreClient {
  db: Db;
  pool: Pool;
  close(): Promise<void>;
}

/**
 * Build a store client from a connection string (or a full `PoolConfig`, e.g. to set a
 * per-connection `search_path` for test isolation). The caller owns the lifecycle and
 * must `close()` it.
 */
export function createStore(config: string | PoolConfig): StoreClient {
  const pool = new Pool(typeof config === "string" ? { connectionString: config } : config);
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
