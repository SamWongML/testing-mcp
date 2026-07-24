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
- **Per-node params representation for P4 (from P3 review) — still open after P8:** the engine's
  runtime `PlanNode` carries a per-node `params` bag, but the normalized `suiteNodeSchema`
  (= `stepSchema`) has no `params` field and `AuthoredSuite` has no `params` builder.
  **P8 update:** `run_suite`/`run_selection` now *accept* a `params` input (and `executeEntry`
  passes it to `runTest`), but `runSuite` has no `params` option, so **suite-level `params` are
  currently silently ignored for suites** — only single-test runs honor them. Wiring suite-level
  params into individual nodes (baking `{{params.*}}` at normalize time, since the manifest
  carries no params builder) is still unbuilt; close it when a suite actually needs run-time
  params. `run_test` (single test) params work end-to-end.
- **`TaskStateStore` grew in P8 → P11 `DynamoTaskStore` must match:** the interface the P11
  Dynamo adapter implements now also has `create()` (insert-only, `attribute_not_exists(run_id)`
  in Dynamo terms) and `TaskRecord` carries `createdAt`/`updatedAt`; the `tasks` table gained a
  `created_at` column. P11's `idempotency` table (§16.2) can replace the stage-1
  "idempotency-key == runId" dedupe that `submitRun` uses today.
- **Two P8 review notes (from P8 re-review) → future session, not defects:** (a) the
  trace-less branch of `SdkTaskStore.getTaskResult` (cancelled/failed task fetched via the raw
  SEP-1686 `tasks/result` call) is only covered indirectly — via `getRunResult`'s direct tests
  and the happy-path `callToolStream` — because `callToolStream` only fetches `tasks/result` on
  `completed`; add a test that calls `client.experimental.tasks.getTaskResult()` on a
  non-passed task if a client ever depends on it. (b) `run_selection` fans out submits with
  `Promise.all`; a very large tag match opens more concurrent transactions than the pg pool
  `max` (they queue, not fail) — bound the concurrency if selections ever get large.
- **Task-row TTL sweep not scheduled (from P8) → P10/P11 operational:** `PostgresTaskStore`
  sets `expiresAt` and implements `deleteExpired()` (the SEP-1686 "results retained for a
  server-defined duration" GC), but **nothing calls it yet**, so terminal `tasks` rows accumulate
  forever. Wire a periodic sweep into the worker loop (or a scheduled job) when adding operational
  hardening; it's a background-GC concern, not a P8 exit-criteria item.
- **SDK Tasks augmentation scope (from P8) → revisit if a client needs it:** only `run_suite` is
  task-augmented (`registerToolTask`, `taskSupport:'required'`). `run_selection` (batch) and
  `run_test`'s long-running auto-task use the plain durable path (poll via the mirror tools).
  The server advertises only `tasks:{cancel,requests:{tools:{call}}}` — `list` is **not**
  advertised and `SdkTaskStore.listTasks` returns `[]`; implement real listing + the `list`
  capability if an agent needs task enumeration. The SDK API is experimental ("may change
  without notice") — re-verify against the installed source on the next SDK bump.
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
- **Golden-master live-capture CLI (from P9) → when a real migration needs it:** `goldenAssertions`/
  `renderAssertions` (`packages/cli/src/golden.ts`) are the pure core (baseline response → parity
  assertions), but nothing *captures* a live baseline yet. Wire an `atp golden <id>` command that runs
  the migrated entry once against the SUT, feeds the recorded (redacted) response through
  `goldenAssertions`, and prints/patches the `assert` block — the §19 step-4 "run once via Inso" step,
  as a first-class CLI. The `import_insomnia_collection` prompt currently tells the agent to do this
  by hand (`atp run <id>` → add assertions).
- **Importer: per-request env override + params vs env split (from P9) → if a migration needs it:**
  `atp import` maps every `{{ _.x }}` to `{{env.x}}` against a single collection-level environment and
  ignores Insomnia sub-environments; it never emits a Zod `params` builder (auth tokens are the only
  `{{secrets.*}}`). Fine for the common case; revisit (sub-env → per-cell env or `params`) if a real
  collection leans on sub-environments or request-scoped variables.
- **Migrations dir must be copied on `tsc` build (from P6) → P11:** `migrate()` resolves
  `db/migrations/*.sql` relative to `import.meta.url`, which works under `tsx`/`vitest` (no
  build). The P11 container build (`tsc` emit to `dist/`) must copy the `migrations` dir into
  the output, or the migrator won't find the `.sql` files at runtime.
