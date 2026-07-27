# Production-readiness status

Live tracker for [production-readiness.md](./production-readiness.md) (the approved plan, kept
unedited). Update this file as work lands; keep the plan as the record of what was decided.

**Branch:** `feat/production-grade-mcp`. Each phase below cites the commits that delivered it.

| Phase | Scope | Status |
|---|---|---|
| Step 0 | Clean up contexts, commit the baseline | ✅ Done |
| Phase 0 | The four smoke-test defects | ✅ Done |
| Phase 1 | Async durability — resume, dead-letter, retention, cancel | ✅ Done, verified against real services |
| Phase 2 | MCP surface conformance | ✅ Done, verified against real services |
| Phase 3 | Request-path operability | ⬜ Not started |
| Phase 4 | AWS wiring and supply chain | ⬜ Not started |

## What "verified" means here

The service-gated suites (`@atp/store`, the async lifecycle) `describe.skipIf` out when their
backing service is absent, so **a green offline run proves nothing about the store paths** —
93 of 606 tests skip. Everything below marked verified was run with real services:

```bash
docker compose -f docker-compose.dev.yml up -d
ATP_TEST_DATABASE_URL=postgresql://atp:atp@localhost:5432/atp \
ATP_TEST_DYNAMO_ENDPOINT=http://localhost:8000 \
ATP_TEST_S3_ENDPOINT=http://localhost:9000 \
  pnpm test
```

Last full run: **606 passed, 0 skipped** (75 files) against Postgres 16, dynamodb-local and
MinIO.

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

## Phase 2 — MCP surface conformance ✅

`53d6ec7` (paging + annotations) · this phase's remainder below.

**Catalog paging (the blocker).** `list_tests` takes `limit`/`cursor` and returns `nextCursor`;
further catalog pages read at `test://catalog/{cursor}`. Keyset cursor over the id-sorted
catalog — opaque per spec, and stable as entries come and go, unlike an offset. Checked against
the SDK's own URI matcher that `test://{id}` cannot swallow the page template.

**Tool annotations.** `destructiveHint` and `openWorldHint` both default to *true*, so an
unannotated reader was indistinguishable from a mutating tool. The six read-only tools now
declare themselves; `cancel_run` is idempotent and non-destructive; the run tools keep the
pessimistic defaults, which are correct — they reach a live SUT.

**`tasks/list` is backed.** `TaskStateStore` gained `list({ limit, cursor })`, implemented on
both backends, and `SdkTaskStore.listTasks` pages straight off the same rows `tasks/get` reads,
so the two cannot disagree. The contract both backends honour is **complete traversal** — follow
`nextCursor` to exhaustion and you see every task exactly once. Ordering is deliberately *not*
in the contract: Postgres pages newest-first over a `(created_at, run_id)` keyset, a DynamoDB
`Scan` walks in hash-key order, and promising an order both could keep would mean adding a GSI.

**Error taxonomy.** `errors.ts` — `AtpError` with a stable `code` (`not_found`,
`invalid_argument`, `forbidden`, `unavailable`, `internal`), rendered two ways because the
protocol permits no single one: `McpServer` flattens *any* throw from a tool handler — `McpError`
included — into `{ content, isError: true }` and discards the JSON-RPC code, so tools carry the
code in `structuredContent.error` while resources throw a real `McpError` (`InvalidParams` for an
unknown id, not the blanket `-32603` they returned before). Message text is unchanged throughout.

**Progress notifications.** `run_test` forwards the engine's existing k/n ticks when the caller
sends a `progressToken`. This is the one server→client message the stateless design permits: it
rides the SSE stream of the request being handled. Delivery is fire-and-forget — a closed stream
must not fail a healthy run.

**`list_runs` cursor.** `listRunsPage` in `@atp/store` keysets over `(started_at, id)` with
filters carried across pages; `listRuns` is now a thin wrapper, so its single existing caller and
its tests were unaffected. History past the newest N is reachable for the first time.

**Polish.** `outputSchema` on `list_tests`/`describe_test`/`run_test`/`list_runs` — the SDK
validates every non-error result against it, so these are enforced rather than documentation
(error results are exempt from that validation, which is what lets the taxonomy's payload
coexist). A `resource_link` block on `run_test` and `get_run_result` pointing at
`run://{runId}/trace.json` — a uri this server actually serves, unlike the `file://`/`s3://`
`artifactUri`, which is untouched beside it. `completions/complete` for prompt args: entry ids
and tags from the live manifest, formats from `REPORT_FORMATS`, and `triage_failure`'s `runId`
from recorded history (empty without a db).

### The bug the paging tests caught

The first `tasks/list` traversal test failed about one run in four. It was not flaky — the
cursor encoded `created_at` at **millisecond** precision while the column stores
**microseconds**, so a cursor built from a row at `.004917` read `.004`, and every row sharing
that millisecond compared as *after* the boundary and was skipped by every page. Three of five
tasks silently vanished from a listing whose entire purpose is "anything gettable is listable".

The fix makes the sort key fixed-width ISO-8601 UTC **text** — selected, ordered by, and
compared against as one expression, so the cursor is provably the value the predicate uses and
no driver type-parsing sits in between. Zero-padded UTC ISO sorts lexicographically in
chronological order, so newest-first is preserved. `tasks.test.ts` pins it with rows written at
hand-set sub-millisecond offsets, which fails deterministically against the old cursor rather
than 25% of the time.

Both stores share one construction — `isoSortKey` in `packages/store/src/keyset.ts`, alongside
the cursor codec. `to_char(…, 'MS')` **truncates** rather than rounds (checked against Postgres
16: `.004999` → `004`, `.999999` → `999`), so no separate `date_trunc` is needed and there is no
overflow-to-`1000` hazard.

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
| `tasks/list` "cursor-paginated" | Paginated, but **ordering is not part of the contract** | Postgres pages newest-first; a DynamoDB `Scan` walks in hash-key order and cannot be ordered without adding a GSI. Promising an order the DynamoDB backend could not keep would be a lie in the interface both implement, so the contract promises complete traversal and the Postgres ordering is documented as a superset. |
| Error taxonomy: "introduce `McpError` with proper `ErrorCode`" | `McpError` on resources; a machine code in `structuredContent` on tools | Not a choice: `McpServer` catches `McpError` from a tool handler and flattens it to `isError: true` + message, discarding the code (`server/mcp.js:136`). Only `UrlElicitationRequired` escapes. So the code *cannot* reach a tool caller over JSON-RPC, and `structuredContent` is the only carrier the tool surface offers. |
| `list_runs` "add `.offset()`/keyset paging" | Keyset only, via a new `listRunsPage` | An offset drifts as runs are recorded mid-traversal — the same reason the catalog cursor is a keyset. `listRuns` kept its old signature as a wrapper so the change is additive for its caller. |
| Polish: "either stop advertising `resources.listChanged` or accept it as inert" | Accepted as inert, and stated in the rules file | Nothing subscribes today, so removing it changes no behaviour while risking a client that branches on the capability. The rules file now says plainly that progress works *within* a request and everything outside one is foreclosed. |
| — | A shared `packages/store/src/keyset.ts` (`isoSortKey` + the cursor codec + `InvalidCursorError`) | Review caught that the `tasks` and `runs` cursor codecs were byte-identical and their SQL sort keys had *already* drifted apart. Worse, both threw a plain `Error`, so a malformed cursor on `list_runs` was classified `internal` — reporting a caller's typo as a server fault, in the exact case the taxonomy's own docstring names as `invalid_argument`. One shared module plus one `classify()` branch closed the duplication and the misclassification together; regression test in `tools.test.ts`. |
| — | Corrected `docs/research.md`'s "the worker … emits MCP progress notifications" | False, and the same class of defect Step 0 existed to fix: the worker is a separate process with no MCP connection. It writes `progressPct`/`currentNode` to the task store, which clients observe by polling `tasks/get`. MCP progress notifications come only from the request path. |

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
- **`list_runs` now paginates** (default 100) and returns `nextCursor`. Same shape of change as
  `list_tests`: a caller that took the whole first page and stopped still works, it just now
  knows there is more.
- **`tasks/list` returns real tasks** where it used to return `{ tasks: [] }`. A client that
  treated the empty list as "this server has no tasks" will now see them.
- An errored tool result gains `structuredContent.error = { code, message }`. Additive — `content`
  and `isError` are unchanged, so a client reading only those sees no difference.
- `run_test` and `get_run_result` gain a trailing `resource_link` content block. A client that
  reads `content[0].text` is unaffected; one that assumed a single block should index, not assume.
- `TaskStateStore` gains `list()`. Any out-of-tree implementation of that interface must add it.
