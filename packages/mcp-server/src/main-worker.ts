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
import { startWorker, workerOptionsFromConfig } from "./worker";

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
  const options = workerOptionsFromConfig(config);
  const worker = startWorker({ ...base, db: store.db, taskStore, logger, telemetry }, options);
  logger.info(
    {
      workerId: worker.workerId,
      entries: base.manifest.entries.length,
      once: config.WORKER_ONCE,
      runId: config.ATP_RUN_ID,
    },
    "atp worker started",
  );

  // A one-off task must exit on its own once its run is done (or its idle budget lapses),
  // otherwise it lingers as an unmanaged worker the autoscaler never scales in.
  if (options.maxRuns !== undefined) {
    void worker.done.then(async () => {
      logger.info({ workerId: worker.workerId }, "one-shot worker finished — exiting");
      await Promise.allSettled([store.close(), taskStore.close(), telemetry?.shutdown()]);
      process.exit(0);
    });
  }

  const shutdown = (): void => {
    void worker
      .stop()
      .then(() =>
        // Own thunk each: a synchronous throw would otherwise escape before allSettled runs.
        Promise.allSettled([
          (async () => store.close())(),
          (async () => taskStore.close())(),
          (async () => telemetry?.shutdown())(),
        ]),
      )
      .finally(() => process.exit(0));
  };
  // `once`: a second signal mid-drain would otherwise re-enter shutdown concurrently.
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main().catch((err: unknown) => {
  console.error("atp worker failed to start:", err);
  process.exit(1);
});
