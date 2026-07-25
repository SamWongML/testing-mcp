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
- **`TaskStateStore` grew in P8 → `DynamoTaskStore` must match — ✅ done (P11, 2026-07-25):**
  `DynamoTaskStore` implements the full interface incl. `create()` (a conditional
  `attribute_not_exists` PutItem) and preserves `created_at` across a replacing `put` via
  `if_not_exists`. The `idempotency` table did replace the stage-1 "key == runId" dedupe on the
  DynamoDB path: `submitRun` now mints the run id independently of the caller's key.
- **Two P8 review notes (from P8 re-review) → future session, not defects:** (a) the
  trace-less branch of `SdkTaskStore.getTaskResult` (cancelled/failed task fetched via the raw
  SEP-1686 `tasks/result` call) is only covered indirectly — via `getRunResult`'s direct tests
  and the happy-path `callToolStream` — because `callToolStream` only fetches `tasks/result` on
  `completed`; add a test that calls `client.experimental.tasks.getTaskResult()` on a
  non-passed task if a client ever depends on it. (b) `run_selection` fans out submits with
  `Promise.all`; a very large tag match opens more concurrent transactions than the pg pool
  `max` (they queue, not fail) — bound the concurrency if selections ever get large.
- **Task-row TTL sweep not scheduled (from P8) — ✅ done (P11):** `sweepExpiredTasks(ctx)` runs
  in the worker loop every 5 minutes (`sweepMs`). On DynamoDB the table's native TTL reaps in
  parallel; both are safe together.
- **SDK Tasks augmentation scope (from P8) → revisit if a client needs it:** only `run_suite` is
  task-augmented (`registerToolTask`, `taskSupport:'required'`). `run_selection` (batch) and
  `run_test`'s long-running auto-task use the plain durable path (poll via the mirror tools).
  The server advertises only `tasks:{cancel,requests:{tools:{call}}}` — `list` is **not**
  advertised and `SdkTaskStore.listTasks` returns `[]`; implement real listing + the `list`
  capability if an agent needs task enumeration. The SDK API is experimental ("may change
  without notice") — re-verify against the installed source on the next SDK bump.
- **S3ArtifactStore (from P6) — ✅ done (P11):** `packages/store/src/aws/s3-artifacts.ts`,
  selected by `ARTIFACT_STORE=s3`. Integration-tested against MinIO, including a presigned URL
  fetched over plain HTTP with no credentials.
- **Catalog snapshot writer (from P6) → P7 — ✅ done (2026-07-24):** `recordManifest(db, manifest)`
  landed in `packages/store/src/manifests.ts` (idempotent; one `manifests` row + one
  `catalog_entries` row per entry), called by `mcp-server` `main.ts` at boot when a db is
  configured. pg-gated tests (`manifests.test.ts`) skip offline — **not yet run against a live
  Postgres**; verify under `ATP_TEST_DATABASE_URL`.
- **Golden-master live-capture CLI (from P9) — ✅ done (2026-07-26):** `atp golden <id>
  --base-url <url>` (`captureGolden` in `packages/cli/src/commands.ts` + `goldenFromResult` in
  `golden.ts`) runs the entry once against a real SUT and prints a paste-ready `assert` block per
  node. It **refuses** without an explicit base URL (capturing against `startMockSut()` would emit
  assertions describing fixture data while looking like real coverage) and **refuses** to emit for
  a node that did not execute, exiting non-zero and naming it. **Still open:** it prints rather
  than patches — rewriting an authored TS `assert` block is a codemod and belongs in its own change.
- **Importer: per-request env override + params vs env split (from P9) → if a migration needs it:**
  `atp import` maps every `{{ _.x }}` to `{{env.x}}` against a single collection-level environment and
  ignores Insomnia sub-environments; it never emits a Zod `params` builder (auth tokens are the only
  `{{secrets.*}}`). Fine for the common case; revisit (sub-env → per-cell env or `params`) if a real
  collection leans on sub-environments or request-scoped variables.
- **Migrations dir must be copied on `tsc` build (from P6) — ✅ moot (P11):** the container runs
  the TypeScript sources under `tsx` rather than a `tsc` emit (matching the repo-wide no-build
  design), so `db/migrations/*.sql` is simply present at runtime. Revisit only if the image ever
  moves to a real build — see the bundle item below.
- **Cross-process trace propagation (from P10) — ✅ done (P11):** the W3C `traceparent` is
  injected into `jobs.spec` (`RunSpec.trace`) at submit and restored as the run span's explicit
  parent in `runClaimedJob`, so agent→server→worker→SUT is one trace. Regression test asserts
  both the shared traceId and the parent span id.
- **OTLP exporter wiring (from P10) — ✅ done (P11):** `resolveExporters(config)` maps
  `OTEL_EXPORTER=console|otlp` (+ `OTEL_EXPORTER_OTLP_ENDPOINT`) to the span exporter and metric
  reader `initTelemetry` takes. `otlp` without an endpoint throws at boot.
- **Denied calls are not audited (from P10) → if security review needs attempt logging:**
  `guardScope` throws *before* `auditRun`, so the audit log records executed runs, not rejected
  attempts. Add a separate authz-failure audit path if failed-attempt visibility is required.
- **Container runs `tsx`, not a built bundle (from P11) → if start-up cost matters:** the image
  executes TypeScript through `tsx` because the whole monorepo resolves `@atp/*` to
  `src/index.ts` via `exports` (ADR-003) — a `tsc` emit would mean rewiring every package's
  exports, well beyond P11's scope. Costs a few hundred ms of transpile at boot and ships the
  sources. If cold-start or image size ever matters, do the build properly (per-package
  `exports` with a `dist` condition, or a single bundler pass) **and** copy
  `packages/store/src/db/migrations/*.sql` into the output.
- **`Data` stack provisions DynamoDB tables even in `postgres` mode (from P11) → cosmetic:**
  the tables are on-demand so an unused pair costs essentially nothing, and always having them
  is what makes `TASK_STORE` a pure environment flip with no infra change. Gate them on a
  context flag only if empty-table noise becomes a problem.
- **`S3ArtifactStore` has no multipart/streaming path (from P11) → if traces get large:**
  `put` sends the whole body in one `PutObject` and `get` buffers the response. Fine for the
  trace/report sizes this produces today; a very large suite trace would want multipart upload
  and a streaming read.
- **No post-deploy smoke step in the runbook (from P11) → operational polish:**
  `docs/deploy.md` step 5 asks for a manual `curl /healthz` + one real run. Worth turning into
  a scripted smoke check (`atp run <id>` against the deployed ALB) wired into the deploy
  pipeline so a bad rollout is caught without a human.
- **`run_selection` fan-out is still unbounded (from P8, reconfirmed P11):** noted below in the
  P8 review items; P11's `isolated` flag makes a large tagged selection able to launch many
  one-off Fargate tasks at once, so bound the concurrency before using `isolated` with a broad
  selection.
- **No OTel collector is provisioned (from the P11 review) → required before the alarms or
  worker autoscaling do anything:** the app exports OTLP only, and `infra/` ships no ADOT
  collector. Until one translates OTLP → CloudWatch `PutMetricData` in namespace `ATP`,
  preserving `infra/src/metrics.ts`'s metric names and the `status` dimension on `runs_total`,
  no metric reaches CloudWatch — the dashboard is blank, every alarm sits in
  `INSUFFICIENT_DATA`, and the worker's `queue_depth` step-scaling never fires. Add an ADOT
  sidecar to both task definitions (plus its config in SSM) or point `otlpEndpoint` at a
  central gateway. Documented in `docs/deploy.md`; deliberately not folded into P11.
- **Worker SIGTERM drain is unbounded (from the P11 review) → if suites outgrow `stopTimeout`:**
  `stop()` stops claiming new work and waits for the in-flight run to finish naturally; it never
  aborts the in-flight HTTP request (only a cancel request does). ECS SIGKILLs after
  `stopTimeout` (120s), after which the lease reaper requeues the run and it re-executes from
  the start. Either raise `stopTimeout` past the longest suite or add a bounded drain that
  converts to a cancel once the budget lapses.
- **No sweep for orphaned idempotency claims (from the P11 review) → low priority:** a crash
  between claiming the key and creating the task is now *self-healing* (the next submission
  adopts the claim), but if no resubmission ever arrives the key sits until DynamoDB's native
  TTL reaps it — up to ~48h past expiry, since `DynamoIdempotencyStore` has no `deleteExpired`
  of its own unlike the tasks table. Harmless (it strands a key, not a run), but a periodic
  sweep would make expiry deterministic the way the task sweep does.
- **`submitRun`/`SdkTaskStore.createTask` still branch on `provider.transactional` (from the
  P11 simplicity review) → if this code is touched again:** the create-or-dedupe → enqueue body
  is repeated across both, and `select.ts`'s doc comment claims callers never see the backend
  choice, which is not quite true. The clean fix is to move create+enqueue **into** the provider
  (`submit(db, {...})`, one implementation per backend). Note if extracting a shared helper: the
  transactional path must **not** catch the enqueue error — calling `tasks.update()` inside an
  already-poisoned Postgres transaction would itself throw — so the asymmetry is load-bearing,
  not laziness. The orphan-adoption fix has since made the two branches *more* different, which
  weakens the extraction case further; revisit only alongside other work here.

