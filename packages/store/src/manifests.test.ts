import { type Manifest, manifestSchema } from "@atp/schema";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { catalogEntries, manifests } from "./db/schema";
import { makeTestDb, pgAvailable, type TestDb } from "./db/test-db";
import { recordManifest } from "./manifests";

function makeManifest(): Manifest {
  return manifestSchema.parse({
    schemaVersion: "1.0",
    gitSha: "deadbeef",
    manifestHash: "sha256:cat",
    entries: [
      {
        id: "identity.login",
        kind: "test",
        version: 1,
        tags: ["smoke"],
        owner: "identity-team",
        isLongRunning: false,
        nodes: [{ id: "login", request: { method: "POST", url: "/auth/login" } }],
        sourcePath: "identity/login.test.ts",
      },
      {
        id: "billing.e2e-refund",
        kind: "suite",
        version: 2,
        isLongRunning: true,
        nodes: [{ id: "start", request: { method: "GET", url: "/x" } }],
        sourcePath: "billing/end-to-end-refund.suite.ts",
      },
    ],
  });
}

describe.skipIf(!pgAvailable)("recordManifest", () => {
  let tdb: TestDb;
  beforeEach(async () => {
    tdb = await makeTestDb();
  });
  afterEach(async () => {
    await tdb.close();
  });

  it("snapshots the manifest and one catalog row per entry", async () => {
    await recordManifest(tdb.db, makeManifest());

    const [m] = await tdb.db.select().from(manifests).where(eq(manifests.hash, "sha256:cat"));
    expect(m).toMatchObject({ hash: "sha256:cat", gitSha: "deadbeef" });

    const rows = await tdb.db
      .select()
      .from(catalogEntries)
      .where(eq(catalogEntries.manifestHash, "sha256:cat"));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "identity.login")).toMatchObject({
      kind: "test",
      version: 1,
      tags: ["smoke"],
      owner: "identity-team",
      isLongRunning: false,
    });
    expect(rows.find((r) => r.id === "billing.e2e-refund")).toMatchObject({
      kind: "suite",
      version: 2,
      isLongRunning: true,
    });
  });

  it("is idempotent — re-recording the same manifest hash does not duplicate or throw", async () => {
    await recordManifest(tdb.db, makeManifest());
    await expect(recordManifest(tdb.db, makeManifest())).resolves.toBeUndefined();

    const rows = await tdb.db
      .select()
      .from(catalogEntries)
      .where(eq(catalogEntries.manifestHash, "sha256:cat"));
    expect(rows).toHaveLength(2);
  });
});
