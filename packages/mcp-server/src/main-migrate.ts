import { loadConfig } from "@atp/schema";
import { createStore, migrate, resolveDatabaseUrl } from "@atp/store";

/**
 * The `MODE=migrate` entrypoint — a one-off ECS task run *before* a rollout (see
 * `docs/deploy.md`). Migrations deliberately do not run at server/worker boot: several tasks
 * start concurrently during a rolling deploy, and DDL racing itself is how a deploy gets
 * wedged. This runs once, prints what it applied, and exits non-zero if anything failed.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const databaseUrl = resolveDatabaseUrl(config);
  if (!databaseUrl) {
    throw new Error("migrations require DATABASE_URL (or DATABASE_SECRET)");
  }

  const store = createStore(databaseUrl);
  try {
    const applied = await migrate(store.pool);
    console.log(
      applied.length > 0
        ? `applied ${applied.length} migration(s): ${applied.join(", ")}`
        : "database already current — nothing to apply",
    );
  } finally {
    await store.close();
  }
}

void main().catch((err: unknown) => {
  console.error("atp migrate failed:", err);
  process.exit(1);
});
