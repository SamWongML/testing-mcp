# Production-grade ATP: closing the gaps the smoke test and audits found

> **This is the approved plan, preserved as written.** It is a record of what was decided and
> why, not a live document — do not edit it as work lands. Progress, deviations, and the
> evidence behind each claim are tracked in
> [production-readiness-status.md](./production-readiness-status.md).
>
> Line/symbol references describe the codebase **as it was when the plan was written**, so
> several no longer resolve — `queue.ts:118` (`reapExpired`) and `tools.ts:78` (`list_tests`)
> in particular have since been rewritten by the work this plan describes.

## Context

The Mockmart smoke test drove this platform end to end — Insomnia import → chain wiring → golden
parity → `validate` → 15 entries executed over the MCP tool surface → HTML reports. It passed, but
it surfaced four defects and could not exercise the async half at all (no Postgres). Three follow-up
audits (async durability, MCP protocol conformance vs. the installed SDK 1.29 / spec 2025-11-25, and
delivery/ops posture) turned that into a full picture: **3 blockers, ~14 important, ~20 polish**.

The headline problems are not the four bugs. They are:

1. **A crashed worker re-executes an entire run from scratch.** `reapExpired`
   (`packages/store/src/queue.ts:118`) requeues a stale lease and `runClaimedJob`
   (`packages/mcp-server/src/worker.ts:94`) calls `executeEntry` fresh — nothing is persisted before
   the terminal write. A suite killed after `POST /payments/:id/capture` fires it again. There is
   also no attempt ceiling, so a job that reliably kills its worker loops forever, invisibly: the
   reap path emits no log and no metric, and the client polls a `working` task indefinitely.
2. **The catalog is unbounded.** `list_tests` (`packages/mcp-server/src/tools.ts:78`) and
   `test://catalog` (`resources.ts:32`) return every entry with no `limit`/`cursor` anywhere in the
   call path. At the documented "thousands of tests" scale that is a multi-MB payload marshaled per
   request straight into an agent's context window.
3. **Production telemetry and credentials are not wired.** The app only exports OTLP and nothing in
   `infra/` provisions a collector, so no metric reaches CloudWatch — worker autoscaling never fires
   and all four alarms sit in `INSUFFICIENT_DATA`, which reads as healthy. Separately, `ATP_SECRET_*`
   appears nowhere in `infra/`, so every authenticated test fails at run time in a deployed stack.

Goal: make this best-in-category as an MCP server for API testing — correct under crash, honest
about its guarantees, conformant with the current MCP spec, and debuggable in production.

**Starting state:** the working tree carries the already-verified `packages/engine/src/auth.ts` fix
(basic/oauth2 credential templates) plus its two regression tests, and the untracked Mockmart corpus
(`fixtures/insomnia/`, `fixtures/sut/`, `tests/mockmart/`, `tests/_shared/*`). All of it should be
committed as the baseline before Phase 1.

## Constraints that shape every phase

- **The engine stays pure** — no MCP/AWS/store import in `@atp/engine`. Persistence enters through
  an injected callback, exactly like the existing `onProgress` in `RunOptionsBase`.
- **Schema first** — representation changes land in `@atp/schema`, then consumers adapt.
- **The MCP tool surface is additive** — never rename or remove a tool or field.
- **Redact before persist** — checkpoints are persisted snapshots, so they inherit this.
- **Migrations are additive/expand-only**, applied by the one-off `MODE=migrate` task.
  `migrate()` auto-discovers `src/db/migrations/*.sql` in filename order; `schema.ts` ↔ SQL is
  kept in sync by hand.

---

## Step 0 — Clean up contexts and commit the baseline (before any phase)

The audits found several **context files that assert things the code does not do**. Left alone they
will mislead every later phase (and every future agent), so they get corrected first — separately
from the code changes, so the cleanup commit is reviewable on its own.

- **Commit the baseline on a branch**: the verified `packages/engine/src/auth.ts` fix + its two
  regression tests, and the Mockmart corpus (`fixtures/insomnia/`, `fixtures/sut/`,
  `tests/mockmart/`, `tests/_shared/{auth,env,steps}`). Keep the fixture SUT — it is the
  verification harness for Phases 1–4, not throwaway smoke-test scaffolding.
- **Correct the stale claims:**
  | Where | Says | Reality |
  |---|---|---|
  | `packages/engine/src/runner.ts:64` | progress ticks map onto "MCP progress notifications" | No such code exists — and it names MCP inside the package whose invariant is to stay pure |
  | `docs/research.md:979` | `/readyz` reports dependency reachability | It only reports "manifest loaded" (Phase 3 makes the doc true) |
  | `docs/deploy.md:165` | a reaped run "re-executes from the start" | True today; Phase 1 changes it — flag it now so the guarantee wording lands with the code |
  | `.claude/rules/mcp-server.md` | lists the surface as if complete | `tasks/list` is unbacked, and server-push is architecturally foreclosed by the stateless design — both worth stating |
- **Add to `CLAUDE.md`**: the Mockmart fixture SUT and the fact that the `mockmart` namespace must be
  run with `--base-url`, since without it `atp run` starts the built-in mock and every route 404s.
  This is exactly the trap the corpus rule warns about, and it is not currently written down.
- **Tidy leftovers**: `.atp/reports/` is gitignored (keep or clear, no impact); background processes
  from the smoke test (fixture SUT, MCP server, static server) are already stopped — confirm nothing
  is still bound to :8899 / :3000 / :8123 before starting.

Gate: `pnpm typecheck && pnpm lint && pnpm validate` clean, then commit.

---

## Phase 0 — The four smoke-test defects (small, independent)

| Defect | File | Fix |
|---|---|---|
| Redaction crashes a run when a query/header value isn't a string (`out.split is not a function`) — a whole-value template preserves the param's type, so a numeric param kills the run | `packages/engine/src/redact.ts:22,45,50` | Mask strings only; pass non-strings through in `redactQuery`/`redactHeaders`. Add a case to `redact.test.ts` with a numeric query value |
| Importer emits `export const mock-mart` for a multi-word collection name — invalid TS | `packages/cli/src/import.ts:429,298,372` | Apply the existing `identifier()` helper (already used for auth bindings) to the env binding; keep the slug for ids/paths. Add an `import.test.ts` case for a two-word collection name |
| Reports print `0.9669160000048578ms` | `packages/reporting/src/util.ts:21` | Round in `ms()`; assert formatting in `util`/renderer tests |
| The "Likely cause" panel is unreadable in dark mode (`#fbe9e7aa` background, inherited light text) | `packages/reporting/src/html.ts` (`.diagnosis` in `STYLE`) | Give the panel an explicit foreground, or gate the background behind `prefers-color-scheme` |

---

## Phase 1 — Async durability and correctness

The load-bearing phase. Full design (with SQL, the rewritten scheduler, and worker wiring) is in the
design output; the essentials:

### 1a. Resume from the DAG frontier

- **`@atp/schema`** (`src/result.ts`, first): `StepResult += resumed?: boolean`;
  `ExecutionResult += runAttempt: number` (default 1) and `firstStartedAt?: string`. All additive —
  nothing in the file is `.strict()`, so stored traces and existing renderers keep parsing.
- **`@atp/engine`** (`src/runner.ts`, the only engine change): add `ResumeState`
  (`{ completed: Record<string, StepResult>; runAttempt?; firstStartedAt? }`) and two optional
  fields on `RunOptionsBase` — `resumeFrom` and `onNodeSettled?: (r: StepResult) => Promise<void> |
  void`. In `scheduleNodes`, seed completed nodes **in plan (topological) order** so the rehydrated
  `{{vars.*}}` bag matches what a from-scratch run would produce, and rehydrate `ctx.nodes[id]` from
  each seed's `extracted` so `{{nodes.X.var}}` still resolves. `onNodeSettled` must be **awaited
  before `settle()`/`pump()`** — that ordering is the durability boundary; anything looser re-opens
  the race. A rejection aborts the run (reuse the existing `AbortSignal.any([...])` cascade) and
  reports `errored` rather than continuing unguarded. `runTest`'s sequential path gets the same seam.
- **Honest guarantee — state it in the docs, not just the code:** with concurrency N, **at most N
  nodes re-execute** after a crash (exactly those in flight when it died). This is bounded
  at-least-once, **not** exactly-once. `docs/deploy.md` currently says a reaped run "does re-execute
  from the start" and must be corrected.

### 1b. Storage for checkpoints

New operational table `run_checkpoints (run_id, node_id, payload jsonb, created_at)`, PK
`(run_id, node_id)` — **not** incremental writes into `step_results`. Rationale: `recordRun`
(`packages/store/src/runs.ts:26`) writes history atomically from a finalized result, and
`executionStatusSchema` is terminal-only by design; making it incremental would put in-flight rows
in `listRuns`. Checkpoints are operational state, like `tasks`. Payload is the full redacted
`StepResult` so a resumed run's report keeps request/response fidelity.

New `packages/store/src/checkpoints.ts`: `putCheckpoint` (upsert), `getCheckpoints`,
`pruneCheckpoints`, `sweepExpiredCheckpoints` — mirroring the existing `sweepExpiredTasks` shape.
Migration `packages/store/src/db/migrations/0001_resumable_runs.sql` plus the matching `schema.ts`
additions.

### 1c. Bounded attempts, backoff, dead-letter

Same migration: `jobs += attempts, max_attempts (default 5), last_error, first_claimed_at`;
`runs += attempt, first_started_at`. `reapExpired` increments `attempts`, applies exponential
backoff through the **already-modelled but never-written `run_after` column**, and transitions to a
new `dead_letter` status once attempts are exhausted (no CHECK constraint on `jobs.status`, so no
DDL needed for the value). `reapOnce` (`worker.ts`) finalizes any dead-lettered row into a terminal
task state — **`cancelRequested` wins over "gave up"** — prunes its checkpoints, and logs it.
`claim()` sets `first_claimed_at` once via `COALESCE`, which is the source of `firstStartedAt`.

### 1d. Wiring

`worker.ts:runClaimedJob` loads checkpoints after resolving the entry (fail-closed: a read error
goes to `finalizeError`, never silently "nothing to resume"), passes `resumeFrom` + an
`onNodeSettled` that calls `putCheckpoint` through `executeEntry` (`execute.ts` gains both
pass-through fields), and prunes checkpoints on **every** terminal path. Add the checkpoint TTL
sweep next to the existing task sweep in `startWorker`'s loop.

### 1e. Retention and mirror-surface consistency

- `get_run`/`get_run_result` read only the `tasks` row, so after the 24h TTL sweep they report "no
  run" while `get_report` and the `run://` resources still render fine — the documented "mirror
  tools observe the same durable state" contract holds for ~24h only. Fix in
  `packages/mcp-server/src/tasks.ts`: fall back to the durable `runs` row / artifact pointer when
  the hot task row is gone.
- Add retention sweeps for terminal `jobs` rows (spec jsonb lives forever today) and `audit_log`,
  and a local-artifact prune. S3 already has a CDK lifecycle rule; `LocalArtifactStore` — the
  default — has none.

### 1f. Cancellation correctness and the missing tests

- `tasks/cancel` returns the task re-read immediately after flagging, so its own response says
  `working`. The SEP-1686 `Task` shape has **no** pending-cancel field (verified against
  `types.d.ts:1036`), so surface the intent through `statusMessage` ("cancellation requested") in
  `toSdkTask` (`sdk-tasks.ts:166`) rather than inventing a field.
- **`cancel_run` has zero test coverage**, and `tasks/cancel` is never tested against a live worker.
  Add both. Also cover cancel-then-crash (the flag survives the reap; worst case ≈ `leaseMs` +
  `reapMs` ≈ 35s) and cancellation at the **default** 1s heartbeat — every existing test overrides
  it to 50ms.
- **Make the fixture SUT count calls** (`packages/mcp-server/src/testkit.ts` → `TestSut.calls`), so
  the crash+resume test can assert `POST /payments/:id/capture` was called **exactly once** across
  both attempts. Today's crash test cannot detect a duplicate because the SUT returns canned
  responses regardless of call count. At the engine layer, `MockAgent`'s single-use interceptors
  give the same proof without a network.

---

## Phase 2 — MCP surface conformance

Grounded in the installed SDK (`types.d.ts`) and spec 2025-11-25, not memory.

- **Pagination (blocker).** Add `limit` + opaque `cursor` to `list_tests` and `nextCursor` to its
  result; add filters + the same paging to `test://catalog`; give `list_runs` a real cursor and add
  `.offset()`/keyset paging to `packages/store/src/runs.ts:84` (history beyond the newest N is
  currently unreachable, which undercuts the `regenerate_reports` workflow). Spec requires cursors be
  **opaque and stable**, and a missing `nextCursor` to mean "end". Note the one compat decision: a
  bounded **default** page size (suggest 200) changes what an existing caller receives. Recommended
  anyway — it is the blocker's actual fix — and additive at the field level.
- **Tool annotations.** Spec defaults are `destructiveHint: true` and `openWorldHint: true`, so the
  *read* tools are the ones that need annotating: `readOnlyHint: true` + `openWorldHint: false` on
  `list_tests`/`describe_test`/`get_report`/`list_runs`/`get_run`/`get_run_result`. Keep the
  conservative defaults for `run_test`/`run_suite`/`run_selection`; `cancel_run` is
  `idempotentHint: true`, non-destructive.
- **`execution.taskSupport`.** The SDK supports it on `Tool` (`types.d.ts:2400`) and the repo sets it
  nowhere — it is how a client learns `run_test`/`run_suite` can be task-augmented. Advertise it.
- **`tasks/list` is a spec violation, not a stub.** `listTasks` returns `{tasks: []}` while
  `tasks/get` returns real tasks; the spec says anything retrievable via `tasks/get` **MUST** be
  retrievable via `tasks/list`. Back it with the durable `tasks` table, cursor-paginated. (The rest
  of the task surface is already compliant — `toSdkTask` correctly carries `createdAt`,
  `lastUpdatedAt`, `ttl`, `pollInterval`.)
- **Error taxonomy.** Every throw is a plain `Error`, so a not-found and an internal fault are
  indistinguishable — and the *same* throw surfaces as `isError: true` text from a tool but as a
  JSON-RPC `-32603 InternalError` from a resource. Introduce `McpError` with proper `ErrorCode`
  (`InvalidParams` for unknown ids/wrong kind) plus a stable machine-readable `code` in
  `structuredContent`. Keep existing message text — several tests assert on substrings.
- **Progress.** `run_test` blocks with no feedback. Read `extra._meta.progressToken` and forward the
  engine's existing `onProgress` ticks via `extra.sendNotification`; `executeEntry` already accepts
  the callback, so this is small.
- **Polish, same phase:** declare `outputSchema` for the tools that already return a stable shape
  (`runSummary`), return the trace as a `resource_link` block instead of a bare `artifactUri`
  string, add `completions/complete` for prompt args (`triage_failure`'s `runId`, tag filters), and
  either stop advertising `resources.listChanged` or accept it as inert — the fresh-server-per-
  request design forecloses server-push entirely, which is worth stating in the rules file.

---

## Phase 3 — Request-path operability

- **`/readyz` lies.** It reports "manifest loaded" while `docs/research.md:979` promises dependency
  reachability — a task booted against a broken `DATABASE_SECRET` still reports ready. Make it check
  the db and artifact store (cheaply, cached), and point the ALB target group at it.
- **The sync run path has no wall-clock budget and no cancellation.** `tools.ts:181` calls
  `executeEntry` with no `signal`, and `runTest` — unlike `runSuite` — has no aggregate timeout
  (`test.timeoutMs` is only a per-step fallback that each retry gets fresh). A multi-step or
  heavily-retried test classified "fast" by `isLongRunning` can occupy an ALB'd request
  indefinitely. Add a server-side budget and thread an `AbortSignal`.
- **In-flight sync runs are lost on deploy.** The worker container gets `stopTimeout: 120s`
  (`infra/src/ecs-stack.ts:186`); the server container gets the platform default and its sync runs
  never entered the queue, so there is no lease/reaper safety net. Set `stopTimeout` on the server
  and drain in-flight requests before exit.
- **The request half of the platform is silent.** `http.ts`, `server.ts`, `tools.ts` and
  `sdk-tasks.ts` contain zero logger calls (`worker.ts:105` is the only `.child()` in the package),
  and `traceId` in `logging.ts:16` is declared but never bound. Add per-request/per-tool-call logging
  with correlation ids, and per-tool RED metrics alongside the existing four run-level instruments.
- **No limits on `/mcp`.** Add `hono/body-limit` and basic rate limiting; `params`/`env` flow
  unbounded into `jobs.spec` and `audit_log.params` jsonb today.

---

## Phase 4 — AWS and supply chain (sequenced last, per your "correctness first")

- **Provision an OTel collector** (ADOT sidecar or service) in the ECS stack and translate OTLP →
  CloudWatch under namespace `ATP` with the `status` dimension. Until this exists, worker
  autoscaling on `queue_depth` cannot fire and every alarm is `INSUFFICIENT_DATA`. Guard the
  dimension-name contract with a test on both sides — that exact mismatch class shipped once before.
- **Wire `ATP_SECRET_*`** from Secrets Manager into both task definitions, document it in
  `docs/deploy.md`'s configuration table, and fail fast at boot when a manifest entry references a
  secret the process does not have — rather than surfacing one unresolved-template error per test.
- **Gate migrate-before-deploy.** Today ordering is enforced only by a human following the runbook.
- **CI/supply chain:** add `pnpm audit`, a container image scan, Renovate/Dependabot, coverage
  measurement with a floor, and digest-pin `node:22-alpine` + `tini`. Add `LICENSE`, `CODEOWNERS`,
  `SECURITY.md`.

---

## Verification

Each phase is independently shippable; stop after any of them.

- **Every phase:** `pnpm typecheck && pnpm lint && pnpm test` — and for Phase 1, with real services:
  `docker compose -f docker-compose.dev.yml up -d` plus the three `ATP_TEST_*` env vars, because a
  green offline run proves nothing about the store paths.
- **Phase 0:** re-run the Mockmart corpus (`tests/mockmart/`) against `fixtures/sut/mockmart-sut.ts`;
  add a numeric-query-param test that currently errors the run and must pass; import a two-word
  collection into a temp root and confirm it compiles.
- **Phase 1 (the proof that matters):** with Postgres up, submit `mockmart.checkout`, let the worker
  execute past `capture-payment`, stale the lease (`UPDATE jobs SET claimed_at = now() - interval '1
  hour'`), `reapOnce`, then let a second worker claim it. Assert the run passes, `runAttempt === 2`,
  and the SUT's call counter shows `POST /payments/:id/capture` was hit **exactly once**. Separately,
  submit with `maxAttempts: 1` and confirm the job dead-letters into a reportable terminal state and
  is never re-claimable.
- **Phase 2:** drive the real MCP surface over Streamable-HTTP (the `mcp.mjs` driver from the smoke
  test): `tools/list` shows annotations + `execution.taskSupport`; `list_tests` returns a bounded
  page plus a working `nextCursor`; an unknown id returns a typed error code; `tasks/list` returns
  the task that `tasks/get` returns; a `progressToken` produces progress notifications.
- **Phase 3:** stop Postgres and confirm `/readyz` goes not-ready while `/healthz` stays ok; confirm
  a slow sync run is cut off by its budget; confirm a tool call emits a log line and a metric.
- **Phase 4:** `pnpm synth`; deploy to a scratch account and confirm a metric reaches CloudWatch, an
  alarm leaves `INSUFFICIENT_DATA`, and a secret-consuming test passes in-cluster.

## Explicitly out of scope

- **Exactly-once execution.** Impossible without SUT cooperation (idempotency keys on the SUT side).
  Phase 1 bounds the window to ≤ N in-flight nodes and makes it visible; it does not eliminate it.
- **A SIGKILL-based integration test.** Crash recovery is proven via engine-level abort with
  single-use interceptors plus real reap/resume wiring, matching this repo's existing crash-simulation
  idiom. A true OS-level kill test is a stretch goal.
- **Server-push notifications** (`resources/subscribe`, `notifications/tasks/status`). The
  fresh-server-per-request stateless design forecloses these; adopting them means adopting sessions
  and an `EventStore`, which is a separate architectural decision.
- **Elicitation and sampling** — defensible non-goals for an agent-facing (not agentic) server.
