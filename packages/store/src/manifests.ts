import type { Manifest } from "@atp/schema";

import type { Db } from "./db/client";
import { catalogEntries, manifests } from "./db/schema";

/**
 * Catalog snapshot writer (research §16.1). The server records the manifest it loaded at
 * boot — one `manifests` row plus a `catalog_entries` row per test/suite — so run history
 * (`runs.manifest_hash`, an FK-free `text` column) can be joined back to the catalog it
 * ran against. Idempotent: the manifest hash is content-addressed, so re-recording the
 * same manifest is a no-op (`onConflictDoNothing` on both primary keys).
 */
export async function recordManifest(db: Db, manifest: Manifest): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(manifests)
      .values({ hash: manifest.manifestHash, gitSha: manifest.gitSha })
      .onConflictDoNothing();

    // Batched: one insert for every catalog entry (Drizzle rejects an empty `.values([])`).
    if (manifest.entries.length > 0) {
      await tx
        .insert(catalogEntries)
        .values(
          manifest.entries.map((e) => ({
            manifestHash: manifest.manifestHash,
            id: e.id,
            kind: e.kind,
            version: e.version,
            tags: e.tags,
            owner: e.owner ?? null,
            isLongRunning: e.isLongRunning,
          })),
        )
        .onConflictDoNothing();
    }
  });
}
