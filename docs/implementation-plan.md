# Implementation Plan — LLM-Driven API Testing Platform (MCP on AWS ECS)

**Source architecture:** [docs/research.md](./research.md)
**Live status:** [docs/PROGRESS.md](./PROGRESS.md) ← update this every session
**Working branch:** `claude/multi-session-plan-133pzy` (until told otherwise)

This plan splits the build into **12 phases (P0–P11)**, each sized to fit comfortably
inside a single coding-agent session with a **≤180k-token context budget**. Phases are
ordered by dependency; each produces a verifiable, committed increment. A session
should complete one phase (occasionally two small adjacent ones), verify it, update
`PROGRESS.md`, commit, and push.

---

## How to run a session (read this first, every session)

1. **Read, in this order (and nothing else up front):**
   - `docs/PROGRESS.md` — find the first phase not marked `done`, read its notes/handoff.
   - This file — only the section for that phase.
   - `docs/research.md` — **only the sections referenced by the phase** (listed per phase).
     Do NOT read the whole research doc; it alone is ~30k tokens.
   - `CLAUDE.md` at repo root — the agent guide (conventions, architecture, invariants).
2. **Verify the previous phase's exit criteria still pass** (run the commands listed
   under its "Exit criteria") before building on it. If broken, fix first — that is the
   session's real starting point.
3. **Build the phase.** Stay inside the phase's file scope. If you discover work that
   belongs to a later phase, write a note in `PROGRESS.md` under that phase instead of
   doing it now.
4. **Verify** the phase's exit criteria.
5. **Close out:** update `PROGRESS.md` (status, checklist, handoff notes for the next
   session), commit with a message like `P3: engine composition (DAG, suites, auth)`,
   and `git push -u origin claude/multi-session-plan-133pzy`.

**Context-budget rules of thumb**
- Prefer `Grep`/targeted `Read` with offsets over reading whole files.
- Don't re-read generated files (`manifest.json`, lockfiles) or `node_modules`.
- When editing many small files, batch related edits; don't re-open files to "check"
  edits that tools already confirmed.
- If a phase feels like it will blow the budget, stop at a clean seam, mark the phase
  `in progress` with precise handoff notes, and push. Partial-but-green beats
  complete-but-truncated.

---

## Phase map & dependencies

```
P0 Foundation
 └─ P1 Schema (@atp/schema)
     ├─ P2 Engine I: single-test execution
     │   └─ P3 Engine II: suites, DAG, auth, matrix
     │       └─ P4 Compile + CLI + sample corpus
     │           ├─ P5 Reporting
     │           └─ P6 Store (Postgres record + queue, artifacts)
     │               └─ P7 MCP server: sync surface
     │                   └─ P8 Worker + MCP Tasks (async lifecycle)
     │                       ├─ P9 Prompts + Insomnia migration
     │                       ├─ P10 Auth + observability
     │                       └─ P11 AWS infra (CDK) + DynamoDB adapter
```

Estimated session load below is the expected context consumption for a focused
session (reading prior code + writing the phase). All are well under 180k; the
buffer is deliberate.

| Phase | Title | Est. load | Depends on |
|---|---|---|---|
| P0 | Monorepo foundation | ~40k | — |
| P1 | Schema package | ~60k | P0 |
| P2 | Engine I — single-test execution | ~90k | P1 |
| P3 | Engine II — composition (DAG/suites/auth/matrix) | ~110k | P2 |
| P4 | Compile step + CLI + sample corpus | ~90k | P3 |
| P5 | Reporting renderers | ~70k | P4 |
| P6 | Store — Postgres record + job queue + artifacts | ~110k | P4 |
| P7 | MCP server — stateless sync surface | ~110k | P5, P6 |
| P8 | Worker + MCP Tasks (async lifecycle) | ~120k | P7 |
| P9 | Prompts + agent workflows + Insomnia migration | ~90k | P8 |
| P10 | AuthN/Z + observability | ~100k | P8 |
| P11 | AWS CDK infra + DynamoDB task store + hardening | ~110k | P8 (P10 ideally) |

---

## P0 — Monorepo foundation

**Goal:** A pnpm-workspaces TypeScript monorepo where every later phase has a home,
with typecheck/lint/test wiring and CI that runs them.

**Research sections:** §6 (repository structure), §4.6 (supporting choices), ADR-001.

**Deliverables**
- `pnpm-workspace.yaml`, `package.json` (root scripts: `build`, `typecheck`, `lint`, `test`, `compile`)
- `tsconfig.base.json` (strict), per-package `tsconfig.json` pattern
- Package stubs (empty `src/index.ts`, package.json with `@atp/*` names):
  `packages/schema`, `packages/engine`, `packages/reporting`, `packages/store`,
  `packages/mcp-server`, `packages/cli`, `tools/compile`
- Vitest configured at the workspace level; one trivial passing test
- ESLint + Prettier (minimal config, no ceremony)
- `.github/workflows/ci.yml`: install → typecheck → lint → test
- `CLAUDE.md`: repo conventions, package map, "how to run a session" pointer
  to this plan, placeholder sections to be filled by later phases
- `.gitignore`, `README.md` updated with the package map

**Explicitly out of scope:** turbo/caching (add only if builds get slow), Docker, any real code.

**Exit criteria**
```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm test
```
All green; CI workflow file present.

---

## P1 — Schema package (`@atp/schema`)

**Goal:** The single source of truth: all Zod v4 schemas + inferred types that every
other package imports. Getting this right first prevents cross-phase rework.

**Research sections:** §7 (the IR — read all of it, including code samples), §14
(ExecutionResult shape requirements), ADR-003, ADR-006.

**Deliverables** (in `packages/schema/src/`)
- `test.ts` — `TestCase`, `Step`, `Request`, `Assertion` (declarative ops + `fn`
  escape-hatch marker), `Extractor`, `RetryPolicy`, `PollPolicy`, `timeoutMs`, tags/owner
- `suite.ts` — `Suite`, node union (`useTest` ref / `useStep` ref / inline step), `needs` edges
- `result.ts` — `ExecutionResult`, `StepResult`, `AssertionResult`, run status enum,
  timing/metrics fields (design for all four renderers in P5)
- `manifest.ts` — `Manifest`, `ManifestEntry` (id, kind, version, tags, owner,
  `isLongRunning`, `paramsSchema` as JSON Schema, normalized nodes, `sourcePath`,
  `gitSha`, `manifestHash`)
- `config.ts` — Zod-validated env/config schema (fail-fast at boot; DB URLs, S3
  bucket, mode server|worker — fields can be optional until later phases use them)
- Matrix support in the test schema (`matrix` cartesian expansion contract)
- Unit tests: valid/invalid fixtures for each schema; JSON-Schema derivation from a
  `params` Zod schema (the mechanism `describe_test` will rely on)

**Design notes**
- Escape-hatch `fn` values must be representable in the manifest as a stable content
  hash (§7.4) — model that now (e.g. `{ fnHash: string }` in normalized form vs. real
  function in authored form). Keep "authored" vs "normalized" types distinct.
- Version every schema file's top-level object (`schemaVersion`).

**Exit criteria:** `pnpm --filter @atp/schema test` green; other packages can
`import { TestCase } from "@atp/schema"`.

---

## P2 — Engine I: single-test execution

**Goal:** A pure engine package (no MCP, no AWS) that runs a single `defineTest`
end-to-end against a real HTTP endpoint: templating → auth stub → request →
assertions → extraction → retry → redaction → `ExecutionResult`.

**Research sections:** §10 (all), §7.1, ADR-001; §4.2 (undici).

**Deliverables** (in `packages/engine/src/`)
- `define.ts` — `defineTest`, `defineEnv` (typed identity fns + Zod validation)
- `variables.ts` — `{{env.*}} {{params.*}} {{secrets.*}} {{matrix.*}}` resolution
  against a scoped `RunContext` (`nodes.*` resolution lands in P3 but design the bag now)
- `http.ts` — undici wrapper: timing capture, redirect policy, per-step timeout,
  `AbortSignal` pass-through, connection pooling
- `assertions.ts` — operators `eq neq gt lt contains matches isString isNumber
  jsonSchema jsonpath` + `fn` escape hatch execution
- `extract.ts` — JSONPath/header/status extraction into the var bag
- `retry.ts` — `max/backoffMs/on:[network|4xx|5xx|assertion]`
- `redact.ts` — secret redaction applied to persisted request/response snapshots
- `runner.ts` — `runTest(testCase, {params, env, secrets, signal})` → `ExecutionResult`
  (a single test = one-node DAG; keep the node-runner reusable for P3)
- Tests using `undici` `MockAgent` (no live network): happy path, each assertion op,
  retry on 5xx, timeout, extraction, redaction, cancellation via AbortSignal

**Explicitly out of scope:** suites/DAG, poll-until, real auth providers, matrix
expansion (schema exists; engine support in P3).

**Exit criteria:** `pnpm --filter @atp/engine test` green; a demo script (kept as a
test) runs a `defineTest` against a MockAgent and produces a valid `ExecutionResult`
that `@atp/schema` parses.

---

## P3 — Engine II: composition (suites, DAG, auth, matrix, polling)

**Goal:** Everything §12 promises: suites that reference tests/steps without copying,
topological execution with bounded parallelism, eventual-consistency polling, real
auth providers, matrix expansion.

**Research sections:** §12 (all), §7.2–7.3, §10.2–10.3, §11.2 (cancellation
expectations only).

**Deliverables** (in `packages/engine/src/`)
- `define.ts` additions — `defineSuite`, `useTest`, `useStep`, `defineAuth`
- `graph.ts` — topo sort, cycle detection (compile-time error), `needs` resolution
- Suite runner — DAG execution, bounded parallelism for independent branches,
  `{{nodes.X.var}}` substitution, per-run `timeoutMs`, cooperative cancellation
  checked between nodes
- `poll.ts` (or in runner) — `poll.untilAssertPasses` with `intervalMs`/`maxMs`
- `auth/` — providers: `bearer`, `basic`, `api-key`, `oauth2-client-credentials`
  (token cached per run), `custom` hook
- Matrix expansion: one authored file → N discrete executable units
- Tests: diamond-DAG suite with chaining, cycle detection failure, param override via
  `useTest(login, {params})`, poll-until success + timeout, each auth provider
  (MockAgent), matrix cell enumeration, mid-suite cancellation

**Exit criteria:** engine tests green; the §7.2 `billing.e2e-refund` example (adapted
to MockAgent) runs end-to-end and produces a multi-step `ExecutionResult`.

---

## P4 — Compile step, CLI, sample corpus

**Goal:** Deterministic discovery: drop a `*.test.ts` file → it appears in
`dist/manifest.json` with zero registration. Plus a local CLI for the inner loop.

**Research sections:** §9 (all), §7.4, §6 (`tests/` layout and conventions), ADR-003.

**Deliverables**
- `tools/compile/` — glob `tests/**/*.{test,suite}.ts`, import, `normalize()`
  (authored → normalized form incl. fn-hashing), validate, emit `dist/manifest.json`
  with `gitSha` + `manifestHash`; clear errors pointing at the offending file
- `packages/cli/` — `atp compile`, `atp list [--tags --owner]`,
  `atp run <id> [--params json] [--env name]` (runs in-process via engine, prints a
  plain-text result summary), `atp validate`
- Sample corpus in `tests/`: `_shared/env/local.ts`, `_shared/auth/example.ts`,
  `_shared/steps/` with one reusable step, `identity/login.test.ts`,
  `billing/` with one test + one suite composing `login` — mirroring §7.1/§7.2
- A tiny local mock SUT (e.g. a Hono server started by tests/CLI dev mode) so
  `atp run` works offline
- CI: add `pnpm compile` to the workflow (manifest built, not committed)

**Exit criteria**
```bash
pnpm compile                         # emits valid dist/manifest.json
pnpm atp list                        # shows the sample corpus
pnpm atp run identity.login          # passes against the local mock SUT
```
Adding a new dummy test file and re-running `pnpm compile` surfaces it with no other change.

---

## P5 — Reporting renderers

**Goal:** One canonical `ExecutionResult` → Markdown, `llm_summary`, HTML, JUnit XML,
`trace.json`. Additive renderers, no format drift.

**Research sections:** §14 (all), ADR-006.

**Deliverables** (in `packages/reporting/src/`)
- `markdown.ts` — status, per-node table, assertion detail, timings, failure diagnostics
- `summary.ts` — `llm_summary`: compact what-ran/what-failed/likely-cause/next-action;
  include the heuristic "likely cause" classifier (401 auth vs schema mismatch vs timeout vs network)
- `html.ts` — self-contained single file (inline CSS/JS), timeline, expandable
  redacted request/response traces
- `junit.ts` — standard JUnit XML
- `trace.ts` — full-fidelity JSON (already-redacted inputs only)
- Golden-file tests for every renderer from shared `ExecutionResult` fixtures
  (pass, fail, retried, cancelled, long suite)
- Wire into CLI: `atp run <id> --report md|html|junit` writes the artifact locally

**Exit criteria:** `pnpm --filter @atp/reporting test` green; `atp run … --report html`
produces a file that opens standalone in a browser.

---

## P6 — Store: Postgres system of record + job queue + artifacts

**Goal:** Persistence behind interfaces. Postgres via Drizzle as record **and** durable
queue (`FOR UPDATE SKIP LOCKED`); artifact store with S3 + local-filesystem
implementations; a `TaskStateStore` **interface** with a Postgres implementation
(DynamoDB adapter deferred to P11 per §18's "dozens" stage).

**Research sections:** §16 (all — table DDL is given), §11.2 (queue claim SQL,
heartbeat/reaper), §18 (stage-1 collapse of DynamoDB into Postgres), ADR-004, ADR-005.

**Deliverables** (in `packages/store/src/`)
- `db/` — Drizzle schema for `manifests`, `catalog_entries`, `jobs`, `runs`,
  `step_results`, `assertion_results`, `audit_log` (§16.1) + a Postgres `tasks` table
  for stage-1 task state; migrations checked in
- `queue.ts` — enqueue, claim (SKIP LOCKED), heartbeat, lease-expiry reaper,
  `cancel_requested` flag
- `tasks.ts` — `TaskStateStore` interface (get/put/update/progress/ttl semantics)
  + `PostgresTaskStore` implementation
- `artifacts.ts` — `ArtifactStore` interface + `S3ArtifactStore` (put/get/presign)
  + `LocalArtifactStore` (dev/tests)
- `runs.ts` — write run history (run + steps + assertions), `list_runs` query
  (by testId/since/status, flakiness-friendly)
- `docker-compose.dev.yml` — Postgres (+ MinIO optional) for local dev/integration tests
- Integration tests against real Postgres (docker), incl. concurrent claim safety
  (two claimers, no double-claim) and reaper requeue

**Exit criteria:** `pnpm --filter @atp/store test` green with dockerized Postgres;
migrations apply cleanly to an empty database.

---

## P7 — MCP server: stateless sync surface

**Goal:** A stateless Streamable-HTTP MCP server (official SDK + Hono) exposing the
catalog and the synchronous execution path. Async/Tasks comes in P8 — here `run_test`
executes fast tests inline and rejects (or stubs) long-running ones.

**Research sections:** §8.1–8.4, §8.6, ADR-002; §2.3–2.4 for SDK/transport specifics.
Use Context7/SDK docs for current `@modelcontextprotocol/sdk` API rather than memory.

**Deliverables** (in `packages/mcp-server/src/`)
- `server.ts` — McpServer + Streamable HTTP in **stateless** mode via Hono;
  `/healthz`, `/readyz`; Zod-validated config at boot (fail fast)
- Manifest loading at boot (path/S3 configurable; hot-reload flag for dev)
- `tools/` (one file per tool): `list_tests`, `describe_test`,
  `run_test` (inline execution for `!isLongRunning`; returns full result + report refs),
  `get_report` (md/json inline; html via artifact-store presign),
  `list_runs` (Postgres history)
- `resources/` — `test://catalog`, `test://{id}`, `run://{runId}/report.md`,
  `run://{runId}/trace.json`
- Inline runs persist history via `@atp/store` and artifacts via `ArtifactStore`
- Integration tests: in-memory MCP client (SDK) → list/describe/run/get_report
  round-trip against the sample corpus + mock SUT
- Dev entrypoint: `pnpm dev:server` runs server + mock SUT + local stores

**Explicitly out of scope:** task augmentation, `run_suite`/`run_selection`,
`get_run`/`cancel_run`, worker, OAuth (P10) — but check scopes-shaped middleware
seams exist so P10 can slot in.

**Exit criteria:** integration tests green; a real MCP client (e.g. MCP inspector or
SDK client script) can list tests, run `identity.login`, and fetch the markdown report.

---

## P8 — Worker + MCP Tasks: async lifecycle

**Goal:** Long-running runs as MCP Tasks (SEP-1686): enqueue → worker claims → progress
→ artifacts → terminal state; polling, cancellation, crash-recovery. The mirror tools
for non-Task clients.

**Research sections:** §11 (all), §8.2 table (task-augmented rows), §8.5 sequence
diagram, §2.2, ADR-004. Verify current SDK Task API against SDK docs/examples —
the extension is experimental (§20 row 1).

**Deliverables**
- `packages/mcp-server/src/tasks.ts` — Task lifecycle glue: create task on
  task-augmented calls, map `tasks/get|result|cancel` onto `TaskStateStore` + queue
- `packages/mcp-server/src/worker.ts` — worker entrypoint (`MODE=worker`): claim loop
  (SKIP LOCKED), heartbeat, run engine with AbortSignal, progress updates
  (node k/n → task store + MCP progress notifications), artifacts to `ArtifactStore`,
  history to Postgres, terminal task state
- Tools: `run_suite` (task by default), `run_test` auto-task when `isLongRunning`,
  `run_selection` (tags/query batch), `get_run`, `get_run_result`, `cancel_run`
  (mirror semantics for non-Task clients)
- Cancellation: `tasks/cancel` → `cancel_requested` flag → worker aborts in-flight
  undici call between nodes
- Reaper wired as part of worker loop (lease expiry → requeue)
- Idempotency key support on run submission (dedupe; table/interface from P6)
- Integration tests: submit long suite → poll to `completed`; cancel mid-run →
  `cancelled`; kill worker mid-run (simulated) → reaper requeues → completes;
  non-Task client path via `get_run`/`get_run_result`
- `pnpm dev:worker`; document the two-process local dev flow in `CLAUDE.md`

**Exit criteria:** the §7.2-style sample suite runs asynchronously end-to-end locally
(server + worker + Postgres) with progress observable during the run and a fetchable
report after; all P7 tests still green.

---

## P9 — MCP prompts, agent workflows, Insomnia migration

**Goal:** The agent-facing layer: MCP prompts encoding the workflows, the migration
path from Insomnia YAML, and the finished `CLAUDE.md` contract.

**Research sections:** §13 (all), §19 (all), §8.3.

**Deliverables**
- `packages/mcp-server/src/prompts/` — `import_insomnia_collection`,
  `author_new_test`, `triage_failure`, `generate_suite`, `regenerate_reports`
  (each: argument schema + instruction template referencing repo conventions)
- `atp import <insomnia.yaml>` — deterministic scaffolder: parse Insomnia YAML,
  map per §13.1 table (request→step, folder→suite, env→`_shared/env`,
  auth→`_shared/auth`, template tags→`extract`/`{{nodes.X.var}}`), emit draft
  `*.test.ts`/`*.suite.ts` files for the agent to refine (deterministic transform
  here; the LLM prompt handles the messy remainder)
- Golden-master helper: capture a baseline response for a migrated test and generate
  parity assertions (status/shape/key fields) per §19 step 4
- `MIGRATION.md` template (Insomnia id → IR id mapping table)
- `regenerate_reports` implementation: re-render stored `ExecutionResult`s to a new format
- Fixture Insomnia YAML + tests for the importer mapping
- `CLAUDE.md` finalized: conventions, recipes (add/edit/compose/migrate/triage),
  full tool/prompt/resource reference

**Exit criteria:** importer converts the fixture collection into compiling tests
(`pnpm compile` green including generated drafts); prompts are listed and renderable
via an MCP client.

---

## P10 — AuthN/Z + observability

**Goal:** Production posture: OAuth 2.1 on the MCP surface, scope-gated tools, audit
logging, and full logs/metrics/traces.

**Research sections:** §15 (all), ADR-007, §2.4 (auth capabilities), §8.1.

**Deliverables**
- `packages/mcp-server/src/auth.ts` — JWT validation (`jose`), RFC 9728
  protected-resource metadata, RFC 8707 resource indicators, `test:read`/`test:run`
  scope checks in every tool handler; config flag to disable for local dev
  (internal-deployment simplification path per ADR-007)
- Audit log writes on every run-invoking call (principal, action, entry, params, scopes)
- Pino structured logging across server + worker; every line carries
  `runId`/`taskId`/`traceId`/`nodeId`; redaction of secrets in logs
- OpenTelemetry tracing: span per MCP call, per run, per HTTP call to the SUT;
  OTLP exporter config (CloudWatch/X-Ray in prod, console/none locally)
- Metrics (EMF or OTel): `runs_total`, `pass_rate`, `run_duration_p50/p95`,
  `queue_depth`, `worker_utilization`, `assertion_failures_total{test}`;
  `queue_depth` published for autoscaling (P11)
- Tests: scope rejection (403-equivalent MCP error), audit rows written,
  log lines carry correlation ids

**Exit criteria:** with auth enabled, unscoped calls are rejected and scoped calls
succeed; a full async run emits correlated logs/spans/metrics observable locally
(console exporter); all prior tests green with auth disabled-by-default in test config.

---

## P11 — AWS infra (CDK), DynamoDB task store, production hardening

**Goal:** Deployable: CDK stacks, container images, DynamoDB `TaskStateStore` adapter
(the §18 "hundreds" stage), autoscaling, and deployment docs.

**Research sections:** §17 (all), §16.2, §18, §11.3, ADR-004/005/008.

**Deliverables**
- `Dockerfile` (multi-stage; `MODE=server|worker`; tini/signal handling for graceful
  shutdown — finish/park in-flight work, release job leases)
- `infra/` CDK app (TypeScript) with stacks: `network` (VPC, subnets, endpoints for
  DynamoDB/S3), `data` (RDS Postgres Multi-AZ, DynamoDB `tasks`+`idempotency` tables
  with TTL, S3 bucket + lifecycle), `ecs` (cluster, ALB'd stateless mcp-server
  service scaling on RPS/CPU, worker service scaling on `queue_depth` + CPU, IAM
  task roles least-privilege, Secrets Manager wiring), `observability`
  (dashboards, alarms: queue depth, pass rate, p95 duration, worker errors)
- `DynamoTaskStore` implementing the P6 `TaskStateStore` interface (state, progress,
  `result_ref`, `cancel_requested`, TTL) + idempotency table adapter; store selection
  by config
- Optional `RunTask` escape hatch for very long runs (§11.3 mode 2) — implement if
  budget allows, else document as a follow-up
- `cdk synth` in CI (no deploy); deployment runbook in `docs/deploy.md`
  (bootstrap, secrets, migrations, first deploy, rollback)

**Exit criteria:** `cdk synth` clean in CI; unit/integration tests for
`DynamoTaskStore` (dynamodb-local in docker) green; store-selection config switches
Postgres↔DynamoDB task state without code changes elsewhere.

---

## Cross-cutting rules (all phases)

- **Never fork the representation** — schema changes happen in `@atp/schema` first,
  consumers adapt (ADR-003, §21).
- **Engine stays pure** — no MCP/AWS imports in `@atp/engine` (§10, §20 row 1).
- **Redact before persist** — any request/response snapshot passes `redact()` (§21).
- **Stateless request path** — no cross-request memory in the MCP service (ADR-002).
- **Additive tool surface** — never rename/remove a tool; add optional fields (§8.6).
- **Every run records `manifestHash` + `gitSha`** (§21).
- **Verify SDK/spec currency** — MCP Tasks is experimental; before P7/P8, check the
  installed SDK's actual API against its docs, not this plan's assumptions (§23 note).
