import { serve } from "@hono/node-server";

import { loadConfig } from "@atp/schema";
import { createStore, recordManifest, type StoreClient } from "@atp/store";

import type { ServerContext } from "./context";
import { buildContext } from "./bootstrap";
import { createHttpApp } from "./http";

/**
 * The `MODE=server` dev entrypoint (`pnpm dev:server`). Validates config (fail fast),
 * builds the stateless context, optionally wires Postgres history — recording the catalog
 * snapshot at boot so run rows join back to their manifest — and serves the MCP + health
 * surface over HTTP. `tsx watch` restarts on source change, so the manifest hot-reloads in
 * dev. Async/long-running execution is the P8 worker; this surface is synchronous only.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  let ctx: ServerContext = await buildContext(config);

  let store: StoreClient | undefined;
  if (config.DATABASE_URL) {
    store = createStore(config.DATABASE_URL);
    await recordManifest(store.db, ctx.manifest);
    ctx = { ...ctx, db: store.db };
  }

  const server = serve({ fetch: createHttpApp(ctx).fetch, port: config.PORT }, (info) => {
    console.log(
      `atp mcp server on http://127.0.0.1:${info.port} — ${ctx.manifest.entries.length} tests, db ${store ? "on" : "off"}`,
    );
  });

  const shutdown = (): void => {
    server.close(() => void store?.close().finally(() => process.exit(0)));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((err: unknown) => {
  console.error("atp mcp server failed to start:", err);
  process.exit(1);
});
