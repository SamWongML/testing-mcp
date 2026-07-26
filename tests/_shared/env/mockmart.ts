import { defineEnv } from "@atp/engine";

/**
 * The `mockmart` environment, migrated from the collection's `Base Environment`. A plain
 * literal, so the resolved env baked into the manifest — and therefore `manifestHash` — is
 * deterministic; `atp run --base-url` / the MCP `env` override redirect it per run.
 *
 * Only the keys the corpus actually addresses survive the migration. The rest moved to
 * where they belong: `password` → `{{secrets.QA_PASSWORD}}`, `region`/`tier` → the
 * search-catalog matrix, `searchTerm`/`slowMs` → params, `legacyUser` → the basic-auth
 * provider (see MIGRATION.md).
 */
export const mockmart = defineEnv({
  baseUrl: "http://127.0.0.1:8899",
  productId: "sku-1001",
});
