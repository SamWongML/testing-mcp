import { serve } from "@hono/node-server";

import { loadConfig } from "@atp/schema";
import {
  createStore,
  createTaskStoreProvider,
  recordManifest,
  resolveDatabaseUrl,
  type StoreClient,
  type TaskStoreProvider,
} from "@atp/store";

import type { ServerContext } from "./context";
import { buildContext } from "./bootstrap";
import { createHttpApp } from "./http";
import { createLogger } from "./logging";
import { resolveExporters } from "./exporters";
import { initTelemetry, type Telemetry } from "./telemetry";

/**
 * The `MODE=server` dev entrypoint (`pnpm dev:server`). Validates config (fail fast),
 * builds the stateless context, optionally wires Postgres history — recording the catalog
 * snapshot at boot so run rows join back to their manifest — and serves the MCP + health
 * surface over HTTP. `tsx watch` restarts on source change, so the manifest hot-reloads in
 * dev. When `DATABASE_URL` is set this also enables the async task surface (`run_suite`,
 * `run_selection`, `get_run`/`get_run_result`/`cancel_run`); the runs themselves execute in
 * the separate `pnpm dev:worker` process. Without a db, the surface is synchronous only.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.LOG_LEVEL,
    base: { service: config.SERVICE_NAME, mode: "server" },
  });
  const telemetry: Telemetry | undefined = config.OTEL_ENABLED
    ? initTelemetry({ serviceName: config.SERVICE_NAME, ...resolveExporters(config) })
    : undefined;

  let ctx: ServerContext = { ...(await buildContext(config)), logger, telemetry };

  // Storage selection is config, not code (P11): the same image runs on the stage-1
  // Postgres collapse or on DynamoDB + S3 depending only on the environment. Built only
  // once a db is confirmed — without one the surface is synchronous-only and never touches
  // task state, so a half-configured TASK_STORE shouldn't fail boot for an unused component.
  let store: StoreClient | undefined;
  let taskStore: TaskStoreProvider | undefined;
  const databaseUrl = resolveDatabaseUrl(config);
  if (databaseUrl) {
    store = createStore(databaseUrl);
    await recordManifest(store.db, ctx.manifest);
    taskStore = createTaskStoreProvider(config);
    ctx = { ...ctx, db: store.db, taskStore };
  }

  const server = serve({ fetch: createHttpApp(ctx).fetch, port: config.PORT }, (info) => {
    logger.info(
      {
        port: info.port,
        tests: ctx.manifest.entries.length,
        db: Boolean(store),
        auth: Boolean(ctx.authn),
      },
      "atp mcp server started",
    );
  });

  const shutdown = (): void => {
    server.close(
      () =>
        // Each step is wrapped in its own thunk: a *synchronous* throw from one (e.g. an SDK
        // client destroy) would otherwise escape before allSettled ever sees the array.
        void Promise.allSettled([
          (async () => store?.close())(),
          (async () => taskStore?.close())(),
          (async () => telemetry?.shutdown())(),
        ]).finally(() => process.exit(0)),
    );
  };
  // `once`: a second signal while draining would otherwise re-enter shutdown concurrently.
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main().catch((err: unknown) => {
  console.error("atp mcp server failed to start:", err);
  process.exit(1);
});
