# Production-readiness status

Live tracker for [production-readiness.md](./production-readiness.md) (the approved plan, kept
unedited). Update this file as work lands; keep the plan as the record of what was decided.

**Branch:** `feat/production-grade-mcp`. Each phase below cites the commits that delivered it.

| Phase | Scope | Status |
|---|---|---|
| Step 0 | Clean up contexts, commit the baseline | ✅ Done |
| Phase 0 | The four smoke-test defects | ✅ Done |
| Phase 1 | Async durability — resume, dead-letter, retention, cancel | ✅ Done, verified against real services |
| Phase 2 | MCP surface conformance | 🟡 Partial — catalog paging + annotations landed |
| Phase 3 | Request-path operability | ⬜ Not started |
| Phase 4 | AWS wiring and supply chain | ⬜ Not started |

## What "verified" means here

The service-gated suites (`@atp/store`, the async lifecycle) `describe.skipIf` out when their
backing service is absent, so **a green offline run proves nothing about the store paths** —
86 of 592 tests skip. Everything below marked verified was run with real services:

```bash
docker compose -f docker-compose.dev.yml up -d
ATP_TEST_DATABASE_URL=postgresql://atp:atp@localhost:5432/atp \
ATP_TEST_DYNAMO_ENDPOINT=http://localhost:8000 \
ATP_TEST_S3_ENDPOINT=http://localhost:9000 \
  pnpm test
```

Last full run: **592 passed, 0 skipped** (75 files) against Postgres 16, dynamodb-local and
MinIO. Offline: 506 passed, 86 skipped.

---

## Step 0 — Contexts cleaned, baseline committed

`c2316b4` `722f238` `4e9a3cf`

Four context files asserted behaviour the code did not have; all corrected:

| File | Claim | Reality |
|---|---|---|
| `packages/engine/src/runner.ts` | progress ticks map onto "MCP progress notifications" | No such code — and it named MCP inside the package whose invariant is purity |
| `docs/research.md` §17.2 | `/readyz` reports dependency reachability | Reports only "manifest loaded"; the ALB targets `/healthz` |
| `.claude/rules/mcp-server.md` | surface listed as complete | `tasks/list` unbacked, catalog unbounded, server-push architecturally foreclosed |
| `CLAUDE.md` | — | Added: `atp run` without `--base-url` silently retargets to the built-in mock |

Baseline committed: the `auth.ts` credential-template fix (basic/oauth2 resolved their
`{{secrets.*}}` values verbatim before this) and the Mockmart corpus, which is now the
verification harness for later phases rather than smoke-test scaffolding.

## Phase 0 — The four smoke-test defects

`5ac7dba` — each with a regression test.

- **`engine/redact.ts`** — a whole-value template preserves its param's type, so a numeric
  param reached `maskSecrets` as a number and threw `out.split is not a function`, erroring the
  whole run *from the persistence path*. Coerce before masking.
- **`cli/import.ts`** — a two-word collection name emitted `export const mock-mart`, which does
  not parse. The env binding now goes through the same `identifier()` the auth bindings use.
- **`reporting/util.ts`** — `ms()` printed raw `performance.now()` deltas
  (`0.9669160000048578ms`).
- **`reporting/html.ts`** — the diagnosis panel set a background but no foreground, rendering
  light-on-light in dark mode on the one element that explains a failure.

## Phase 1 — Async durability ✅

`2bd03c1` (engine) · `4396a4a` (store + worker) · `6b3464f` (runbook)

**Resume from the DAG frontier.** `RunOptionsBase` gained `resumeFrom` and `onNodeSettled`;
the engine awaits the latter *before* any dependent starts, which is the entire durability
guarantee — "recorded ⇒ definitely ran". Seeds rehydrate in plan order so a resumed run's
last-writer-wins `{{vars.*}}` bag matches a from-scratch run. `run_checkpoints` (operational
state, like `tasks` — not history) backs it; the worker loads on claim, writes per node, and
prunes on every terminal path, with a TTL sweep as backstop.

**The guarantee, stated honestly:** bounded at-least-once, *not* exactly-once. Nodes recorded
before the crash never re-run; the ≤ `concurrency` nodes in flight when the worker died may.
Documented in `docs/deploy.md`.

**Bounded attempts.** `jobs` gained `attempts`/`max_attempts`/`last_error`/`first_claimed_at`.
The reaper counts each lease expiry, spaces retries via the previously-unused `run_after`
column, and dead-letters at the ceiling — freezing `worker_id`/`claimed_at` for forensics.
`reapOnce` finalizes dead-lettered rows into a terminal task state (a pending cancel wins over
"gave up") and the reap loop now logs.

**Retention + mirror consistency.** Terminal `jobs` rows swept after 7 days; `get_run` /
`get_run_result` fall back to run history when the hot task row is TTL-swept, so they no longer
report "no such run" for runs `get_report` still renders.

**Evidence.** The headline test — *"crash mid-suite → resume runs only the remainder, re-firing
nothing"* — asserts the fixture SUT saw `POST /orders` and the capture **exactly once** across
both attempts, using a new per-route call counter on `TestSut`. The engine-level proof uses
single-use `MockAgent` interceptors, so a re-sent request fails the test outright. The
await-ordering test was checked by removing the await and confirming it fails. `cancel_run`,
which had **zero** coverage, is now driven through the tool against a live worker.

## Phase 2 — MCP surface conformance 🟡

`53d6ec7` — landed so far:

- **Catalog paging (the blocker).** `list_tests` takes `limit`/`cursor` and returns
  `nextCursor`; further catalog pages read at `test://catalog/{cursor}`. Keyset cursor over the
  id-sorted catalog — opaque per spec, and stable as entries come and go, unlike an offset.
  Checked against the SDK's own URI matcher that `test://{id}` cannot swallow the page template.
- **Tool annotations.** `destructiveHint` and `openWorldHint` both default to *true*, so an
  unannotated reader was indistinguishable from a mutating tool. The six read-only tools now
  declare themselves; `cancel_run` is idempotent and non-destructive; the run tools keep the
  pessimistic defaults, which are correct — they reach a live SUT.

Verified over Streamable-HTTP against a running server, not only in-process.

**Remaining in this phase**, roughly in value order:

1. **Back `tasks/list`** — `SdkTaskStore.listTasks` returns `{ tasks: [] }` while `tasks/get`
   returns real tasks. The spec says anything gettable MUST be listable, so this is a
   conformance violation, not a stub. Needs a `list` on `TaskStateStore` plus both backends.
2. **Error taxonomy** — every throw is a plain `Error`, so "unknown id" and "internal fault"
   are indistinguishable; worse, the same throw surfaces as `isError: true` from a tool but as
   JSON-RPC `-32603` from a resource. Wants `McpError` with real codes plus a stable machine
   code in `structuredContent` (existing tests assert on message substrings — keep the text).
3. **Progress notifications** — read `extra._meta.progressToken` and forward the engine's
   existing `onProgress` ticks; `executeEntry` already accepts the callback.
4. **`list_runs` cursor** — needs keyset paging in `@atp/store`'s `listRuns`, which today has
   `limit` but no offset, making history beyond the newest N unreachable.
5. Polish: `outputSchema` for the tools with a stable shape, `resource_link` for `artifactUri`,
   `completions/complete` for prompt args.

## Phase 3 — Request-path operability ⬜

Not started. Scope unchanged from the plan: dependency-aware `/readyz`, a wall-clock budget and
`AbortSignal` for the synchronous `run_test` path, `stopTimeout` + drain on the server
container, per-request/per-tool logging and RED metrics (the request half of the platform emits
no logs at all today), and body-size/rate limits on `/mcp`.

## Phase 4 — AWS wiring and supply chain ⬜

Not started. The two blockers here remain exactly as the plan describes: no OTel collector is
provisioned, so no metric reaches CloudWatch (worker autoscaling never fires and all four
alarms sit in `INSUFFICIENT_DATA`, which reads as healthy); and `ATP_SECRET_*` appears nowhere
in `infra/`, so every authenticated test would fail at run time in a deployed stack.

---

## Deviations from the plan

| Plan said | What was done | Why |
|---|---|---|
| Backoff `5 * 2^attempts` (5s, 10s, 20s…) | `5 * (2^attempts − 1)` — first retry immediate, then 5s/15s/35s… | A single lease expiry is usually a one-off (deploy, OOM); delaying it adds latency for nothing. It is the *repeat* crash that needs spacing. Also preserves the existing reaper test's immediate re-claim, which encodes real behaviour. |
| Retention sweeps for `jobs` **and** `audit_log`, plus a local-artifact prune | `jobs` only | Silently expiring audit records without explicit operator intent is the wrong default for a compliance record. Local artifacts back `get_report`; S3 already has a lifecycle rule and the local store is a dev backing. Both left for a deliberate decision. |
| Advertise `execution.taskSupport` — "the repo sets it nowhere" | No change | The audit was wrong: `run_suite` already declares `taskSupport: "required"`. And `registerTool`'s config type doesn't accept `execution` at all — only `registerToolTask` does — so the non-task tools cannot declare it through the high-level API. Omission already means unsupported. |
| — | `migrate.test.ts` now reads the migrations directory instead of hardcoding filenames | It asserted `["0000_init.sql"]` exactly, so it failed on the new migration while testing nothing extra. The invariant is "every migration applies and re-running is a no-op". |
| — | Added a test for the `getRun` history fallback | The existing TTL-sweep test never *executes* its runs, so no history row exists and the fallback was never exercised. The claim needed its own test. |

Two Drizzle shapes the design flagged as unverifiable without a database — the composite-target
`onConflictDoUpdate` and the `CASE`-based `.set()` in `reapExpired` — both typecheck and pass
against real Postgres. No raw-SQL fallback was needed.

## Behaviour changes callers should know about

- **`list_tests` and `test://catalog` now paginate** (default 200). A caller that previously
  received the whole catalog now receives the first page plus a `nextCursor`. This is the one
  breaking-ish change in the set; it is also the actual fix for the unbounded-payload blocker.
- `ExecutionResult` gains `runAttempt` (defaults to 1, so an unresumed run is unchanged) and
  `firstStartedAt`; `StepResult` gains `resumed`. Additive — stored traces still parse.
- `jobs.status` gains `dead_letter`, a terminal state that is never re-claimed.
- `get_run` / `get_run_result` now answer for runs whose hot task row has been TTL-swept.
