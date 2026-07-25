import { loadConfig } from "@atp/schema";
import {
  createStore,
  createTaskStoreProvider,
  recordManifest,
  resolveDatabaseUrl,
  type StoreClient,
} from "@atp/store";

import { buildContext } from "./bootstrap";
import { createLogger } from "./logging";
import { resolveExporters } from "./exporters";
import { initTelemetry, type Telemetry } from "./telemetry";
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
  const databaseUrl = resolveDatabaseUrl(config);
  if (!databaseUrl) {
    throw new Error("the worker requires DATABASE_URL (async runs need a durable queue)");
  }

  const logger = createLogger({
    level: config.LOG_LEVEL,
    base: { service: config.SERVICE_NAME, mode: "worker" },
  });
  const telemetry: Telemetry | undefined = config.OTEL_ENABLED
    ? initTelemetry({ serviceName: config.SERVICE_NAME, ...resolveExporters(config) })
    : undefined;

  const base = await buildContext(config);
  const store: StoreClient = createStore(databaseUrl);
  await recordManifest(store.db, base.manifest);

  const taskStore = createTaskStoreProvider(config);
  const worker = startWorker({ ...base, db: store.db, taskStore, logger, telemetry });
  logger.info(
    { workerId: worker.workerId, entries: base.manifest.entries.length },
    "atp worker started",
  );

  const shutdown = (): void => {
    void worker
      .stop()
      .then(() =>
        Promise.allSettled([
          store.close(),
          Promise.resolve(taskStore.close()),
          telemetry?.shutdown(),
        ]),
      )
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((err: unknown) => {
  console.error("atp worker failed to start:", err);
  process.exit(1);
});
