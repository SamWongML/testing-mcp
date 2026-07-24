import { loadConfig } from "@atp/schema";
import { createStore, recordManifest, type StoreClient } from "@atp/store";

import { buildContext } from "./bootstrap";
import { startWorker } from "./worker";

/**
 * The `MODE=worker` dev entrypoint (`pnpm dev:worker`). It shares the server's boot path —
 * validate config, build the stateless context, record the catalog snapshot — but instead of
 * serving HTTP it runs the claim→execute→reap loop against the queue. Requires a run database
 * (async execution is inherently durable); pair it with `pnpm dev:server` for the two-process
 * local flow. `tsx watch` restarts it on source change, so the manifest hot-reloads in dev.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.DATABASE_URL) {
    throw new Error("the worker requires DATABASE_URL (async runs need a durable queue)");
  }

  const ctx = await buildContext(config);
  const store: StoreClient = createStore(config.DATABASE_URL);
  await recordManifest(store.db, ctx.manifest);

  const worker = startWorker({ ...ctx, db: store.db });
  console.log(
    `atp worker ${worker.workerId} started — ${ctx.manifest.entries.length} entries in catalog`,
  );

  const shutdown = (): void => {
    void worker.stop().then(() => store.close().finally(() => process.exit(0)));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((err: unknown) => {
  console.error("atp worker failed to start:", err);
  process.exit(1);
});
