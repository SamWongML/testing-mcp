# Deferred / discovered work

> Index: [docs/PROGRESS.md](./PROGRESS.md)

Items found mid-session that belong to a later phase — park them here instead of
doing them out of order.

- **Redirect policy + connection pooling (from P2):** undici v7 moved redirect
  following off `request` options onto a dispatcher `redirect` interceptor, and
  pooling onto a `Pool`. `http.ts` uses the global dispatcher today (fine for
  MockAgent + most SUT calls). Wire an explicit dispatcher with the `redirect`
  interceptor + pooling when a real deployment needs it (P10/P11 territory, or
  sooner if a test SUT requires following redirects).
- **Authored-input validation for the runtime path (from P3 poll review):** `runTest`/
  `runSuite` consume the *authored* (function-carrying) types and never `stepSchema.parse`
  them, so scalar policy fields bypass their Zod refinements at run time. `pollPolicySchema`
  enforces `intervalMs`/`maxMs` positive, but an authored `poll: { intervalMs: 0, maxMs }`
  reaches `withPoll` unguarded → a near-zero-spacing re-send loop that hammers the SUT for
  the whole `maxMs`. `defineTest` today only guards `id`/`version`/`steps.length`.
  **PARTIALLY CLOSED (P4 `normalize`):** the compile path now runs `stepSchema.parse` per node
  and `matrixSchema.parse(def.matrix)`, so a non-positive `poll.intervalMs` **and** an empty
  matrix dimension (`{ region: [] }`) throw at compile with tests covering both. **Still open:**
  the *direct* authored `runTest(...)`/`runSuite(...)` dev/test path (bypassing compile) remains
  trusted, and `normalize` does not yet run the full `testCaseSchema`/`suiteSchema.parse` on the
  top-level authored object (it validates per-node + matrix + the emitted entry, not e.g.
  duplicate matrix **values** → duplicate cell ids). Consider a top-level authored parse if a
  gap bites.
- **Per-node params representation for P4 (from P3 review):** the engine's runtime
  `PlanNode` carries a per-node `params` bag, but the normalized `suiteNodeSchema`
  (= `stepSchema`) has no `params` field and `AuthoredSuite` has no `params` builder.
  So (a) `run_suite {params}` (research §8.2) has no wiring into individual nodes yet,
  and (b) P4's compile step must decide how each node's resolved `params`/`with`
  bindings land in the *serializable* manifest — most likely by resolving `{{params.*}}`
  into the node's request templates at normalize time (baking), since the manifest
  carries no params builder. Settle this before the compile step hard-codes an assumption.
- **S3ArtifactStore (from P6) → P11:** the `ArtifactStore` interface + `LocalArtifactStore`
  landed in P6; the S3 implementation (`@aws-sdk/client-s3` put/get + presigned URLs via
  `@aws-sdk/s3-request-presigner`) is deferred to P11 (the AWS phase), behind the same
  interface and alongside the `DynamoTaskStore` — there's no AWS to integration-test against
  before then, and the SDK deps are heavy. P7 uses `LocalArtifactStore` locally.
- **Catalog snapshot writer (from P6) → P7 — ✅ done (2026-07-24):** `recordManifest(db, manifest)`
  landed in `packages/store/src/manifests.ts` (idempotent; one `manifests` row + one
  `catalog_entries` row per entry), called by `mcp-server` `main.ts` at boot when a db is
  configured. pg-gated tests (`manifests.test.ts`) skip offline — **not yet run against a live
  Postgres**; verify under `ATP_TEST_DATABASE_URL`.
- **Migrations dir must be copied on `tsc` build (from P6) → P11:** `migrate()` resolves
  `db/migrations/*.sql` relative to `import.meta.url`, which works under `tsx`/`vitest` (no
  build). The P11 container build (`tsc` emit to `dist/`) must copy the `migrations` dir into
  the output, or the migrator won't find the `.sql` files at runtime.
