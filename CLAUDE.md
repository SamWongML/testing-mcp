# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An LLM-driven API testing platform exposed over MCP. Tests are authored as typed, declarative
`defineTest`/`defineSuite` values, compiled to a normalized JSON manifest, and executed by a pure
in-house DAG engine. The result is rendered to Markdown / HTML / JUnit / an `llm_summary`.

## Session workflow — read before starting work

**The phased build (P0–P11) is complete.** `docs/PROGRESS.md` is the index — under 150 lines,
read it whole. There is no "next phase" to read into; new work comes from
`docs/deferred.md`, the standing backlog of items earlier phases parked.

1. Open `docs/PROGRESS.md` (status + how to close out a piece of work) and `docs/deferred.md`.
2. Read **only** the `docs/research.md` sections the work touches. `research.md` is ~30k
   tokens; never read it whole. `docs/implementation-plan.md` holds the original per-phase
   scope and exit criteria if you need to know why something is the way it is.
3. Verify the gate before building on it: `pnpm typecheck && pnpm lint && pnpm test &&
   pnpm validate`.
4. Close out by appending one row to `docs/phases/session-log.md`, then commit and push.

Handoff notes for each finished phase live in `docs/phases/P<n>.md` — read one **only** if you
are revisiting that work; they are not session-start reading. **Never let `PROGRESS.md` grow
past 150 lines**: it is read in full every session.

**Current state:** P0–P11 done — the platform is built, tested, and deployable. `@atp/schema`,
`@atp/engine`, `@atp/reporting`, `@atp/store`, `@atp/cli`, `@atp/mcp-server`, `tools/compile`,
and the `infra` CDK app are implemented, with a sample corpus in `tests/`. The MCP server has a stateless **sync** surface
(`pnpm dev:server`) and, when a run database is configured, an **async** surface: `run_suite` (an
SEP-1686 MCP Task), `run_selection`, and the `get_run`/`get_run_result`/`cancel_run` mirror tools,
executed by a separate worker (`pnpm dev:worker`). It also exposes the five workflow **prompts**
(§8.3) and the `atp import` Insomnia scaffolder (see *MCP surface & agent recipes* below). P10
added an **OAuth 2.1 gate** (jose JWT validation, RFC 9728 metadata, RFC 8707 audience,
`test:read`/`test:run` scopes, audit log) and **observability** (Pino structured logs + OTel
traces/metrics incl. `queue_depth`). P11 added the **deployment layer**: a CDK app (`infra/`),
one container image running `MODE=server|worker|migrate`, and DynamoDB/S3 store adapters
selected by config. **Everything AWS-flavoured is off by default** — `TASK_STORE=postgres`,
`ARTIFACT_STORE=local`, `AUTH_ENABLED`/`OTEL_ENABLED`/`RUN_TASK_ENABLED` false — so dev and
test run exactly as before (ADR-007 internal-deployment path).

**Integration tests gate on their backing service and skip when it is absent**, so `pnpm test`
stays green offline: `ATP_TEST_DATABASE_URL` (Postgres), `ATP_TEST_DYNAMO_ENDPOINT`
(dynamodb-local), `ATP_TEST_S3_ENDPOINT` (MinIO) — all three in `docker-compose.dev.yml`. Skips
in a local run are expected, not a regression; with all three services up the suite is
**535 passed | 0 skipped**.

**Two-process local dev (async runs).** Async execution needs a durable queue, so bring up
Postgres and run the server and worker as two processes sharing one `DATABASE_URL`:

```bash
docker compose -f docker-compose.dev.yml up -d                        # Postgres 16
export DATABASE_URL=postgresql://atp:atp@localhost:5432/atp
pnpm dev:server   # terminal 1 — MCP HTTP surface (enqueues async runs, serves tasks/*)
pnpm dev:worker   # terminal 2 — claims jobs, runs the engine, drives task state
```

Without `DATABASE_URL` the server is synchronous-only (P7 surface) and `pnpm dev:worker` fails fast.
`docker compose … up -d` also starts dynamodb-local (`:8000`) and MinIO (`:9000`) for the P11
adapter suites; dev itself needs only Postgres.

**Deploying.** `docs/deploy.md` is the runbook (bootstrap → image → migrate → deploy → rollback).
`pnpm synth` runs `cdk synth` for all four stacks and needs no AWS credentials and no Docker.

## Commands

```bash
pnpm install                 # Node 22+ required; `corepack enable` (pnpm 10.33 is pinned)
pnpm typecheck               # tsc --noEmit over packages/*/src + tools/*/src — the authoritative check
pnpm lint                    # eslint
pnpm test:quiet              # vitest run --reporter=dot — the in-loop default
pnpm test                    # vitest run, full reporter — use when something fails
pnpm format                  # prettier --write .   (Markdown is intentionally excluded)
pnpm compile                 # discovery → dist/manifest.json
pnpm validate                # compile + §19 strictness: no unwired __TODO_CHAIN__, no `status lt 500`-only node
pnpm atp list|run|validate   # local dev CLI over the tests/ corpus (P4)
pnpm atp import <file.yaml>  # scaffold defineTest/defineSuite drafts + MIGRATION.md from Insomnia v5 (P9)
pnpm atp golden <id> --base-url <url>   # run once against a real SUT → paste-ready parity asserts
pnpm dev:server              # MCP HTTP surface (needs DATABASE_URL for the async path)
pnpm dev:worker              # async run worker (requires DATABASE_URL)
pnpm synth                   # cdk synth for all four stacks (no AWS creds, no Docker) (P11)
docker build -t atp:dev .    # the deployment image: MODE=server|worker|migrate
```

CI (`.github/workflows/ci.yml`) runs — and must stay green on — install → typecheck → lint →
test (with Postgres, dynamodb-local, and MinIO service containers) → compile → validate →
`pnpm synth` → `docker build`.

Narrow the test run while iterating: `pnpm exec vitest run <path>` (one file), `pnpm exec vitest run
-t "<substring>"` (by name), `pnpm --filter @atp/engine test` (one package).

## Architecture

**The pipeline.** Authored TypeScript (`defineTest`/`defineSuite`, which carry real functions) →
normalizer → normalized JSON **manifest** (fully serializable) → the **engine** executes it → a typed
`ExecutionResult` → renderers. The manifest — not the source files — is what the server loads at
runtime (ADR-003).

**Monorepo layout.** pnpm workspaces over `packages/*`, `tools/*`, and `infra`. Internal `@atp/*` packages
resolve to their `src/index.ts` via the `exports` field, so cross-package imports need no build step
in dev/test. To add a cross-package dependency, add `"@atp/x": "workspace:*"` to that package's
`dependencies` and run `pnpm install`. Dependency direction: `schema` ← `engine` ← everything else;
`tools/compile` builds on `schema` + `engine`. The package-responsibility table is in `README.md`.

Per-package detail (representation model, execution model, template scopes, store test gating, MCP
statelessness) lives in `.claude/rules/*.md` and loads automatically when you open a file it covers.

## MCP surface & agent recipes

The surface is small and fixed — tests are *data*, so authoring a new test never needs a new tool.

**Tools.** `list_tests` (catalog query) · `describe_test` (one entry's node graph + params schema) ·
`run_test` (sync verdict; auto-tasks a long-running test) · `get_report {runId, format}` (re-render a
stored run: md/html/junit/json/summary) · `list_runs` (history). *Async surface (needs a run db):*
`run_suite` (SEP-1686 Task) · `run_selection {tags}` (batch) · `get_run`/`get_run_result`/`cancel_run`
(mirror tools that observe the same durable state as the Task).

**Prompts** (`packages/mcp-server/src/prompts/`, always registered — §8.3): `import_insomnia_collection`
· `author_new_test` · `triage_failure` · `generate_suite` · `regenerate_reports`. Each renders a
concrete instruction template over the real tools/CLI; edit the template, not each caller's prompt.

**Resources** (`resources.ts`): `test://catalog` (the manifest) · `test://{id}` (one normalized
entry) · `run://{runId}/report.md` · `run://{runId}/trace.json`.

**Recipes** (the workflows the prompts encode):
- *Add a test* → `author_new_test`: new `tests/<domain>/<name>.test.ts`, unique dotted id, Zod
  `params`, declarative asserts; `pnpm compile` + `pnpm typecheck`, then `run_test`.
- *Edit a test* → change the `*.test.ts` declaratively; `tsc` + compile catch regressions.
- *Compose a suite* → `generate_suite`: reuse first (`list_tests` → `useTest`/`useStep`), explicit
  `needs`, `{{nodes.X.var}}` across branches.
- *Migrate from Insomnia* → `atp import <file.yaml>` scaffolds drafts + `MIGRATION.md`; the
  `import_insomnia_collection` prompt drives wiring the `__TODO_CHAIN__` response-refs, then
  `atp golden <id> --base-url <url>` captures parity assertions from the real SUT (§19 step 4).
  **`atp validate` is the definition of "migration finished"** — it fails while a `__TODO_CHAIN__`
  survives or a node still carries only the scaffolded `status lt 500` (the pair that makes an
  unfinished migration pass while being incapable of failing). Deterministic transform in
  `packages/cli/src/import.ts`; rules in `strict.ts`; capture in `golden.ts` + `commands.ts`.
- *Triage a failure* → `triage_failure {runId}`: `get_report` + `run://{id}/trace.json` → hypothesis
  (auth vs schema-drift vs timeout) → fix or quarantine → re-run.
- *Regenerate reports* → `regenerate_reports {format}`: `list_runs` → `get_report {runId, format}` per
  run (pure re-render of stored `ExecutionResult`s; nothing re-executes).

## Invariants

These hold across all phases (ADR references point into `docs/research.md`):

- **Schema is the source of truth** — representation changes land in `@atp/schema` first (ADR-003).
- **The engine stays pure** — never import MCP or AWS code into `@atp/engine`.
- **Redact before persist** — any request/response snapshot passes `redact()` first.
- **Additive MCP tool surface** — never rename or remove a tool or field; add optional fields.
- **Stateless request path** — no cross-request memory in the MCP service (ADR-002).
- **Every run records `manifestHash` + `gitSha`.**
- **Storage backing is config, never code** (P11, §18) — `TASK_STORE`/`ARTIFACT_STORE` select the
  adapter; everything above `@atp/store` goes through the `TaskStateStore`/`ArtifactStore` seams
  (in `mcp-server`, via `taskStoreFor(ctx, db)`).

## Conventions

- TypeScript strict + ESM throughout. The base tsconfig sets `verbatimModuleSyntax`,
  `isolatedModules`, and `noUncheckedIndexedAccess`, so use `import type` for type-only imports and
  treat indexed access as possibly-`undefined`.
- Cheap structural guards live in the `defineX` helpers (fail fast where the value is authored);
  shape validation lives in Zod `.refine`s (fail at parse time). Ids are addressing keys (`needs`
  edges, `{{nodes.X.*}}` templates, manifest lookup) and are `.refine`d unique.
- **Test-file location matters.** Platform unit tests sit beside their source as
  `packages/**/src/**/*.test.ts` (and `tools/**/src/**/*.test.ts`) — exactly what `vitest.config.ts`
  matches. The `tests/` corpus is *also* `*.test.ts` but is deliberately **not** matched by that
  config; keep platform unit tests under `src/`.

## Key docs

- `docs/PROGRESS.md` — the index: phase status, the current phase's checklist, archiving procedure.
- `docs/implementation-plan.md` — the phase-by-phase plan with per-phase exit criteria.
- `docs/research.md` — architecture rationale and ADRs (large; read only the sections a phase cites).
- `docs/deferred.md` — work parked for a later phase. Read at the start of every phase.
- `docs/phases/P<n>.md` — archived handoff notes, one per done phase. On demand only.
- `README.md` — the package-responsibility map.

## Compact Instructions

When compacting, preserve verbatim: the current phase id and its unfinished checklist items from
`docs/PROGRESS.md`, that phase's exit criteria, the exact command and output of the most recent
failing check, and any file paths edited but not yet verified. Drop file contents already written to
disk and the reasoning that led to committed decisions — re-read the file instead.
