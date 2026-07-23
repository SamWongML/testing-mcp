# Progress Tracker — API Testing Platform

**Plan:** [docs/implementation-plan.md](./implementation-plan.md) · **Architecture:** [docs/research.md](./research.md)

> **Every session:** find the first phase below not `✅ done`, read its handoff notes,
> read that phase's section in the plan, verify the previous phase's exit criteria,
> build, then update this file (status, checkboxes, session log, handoff notes),
> commit, and push before ending the session.

**Status legend:** ⬜ not started · 🔄 in progress · ✅ done · ⏸ blocked

## Phase status

| Phase | Title | Status | Session(s) | Exit criteria verified |
|---|---|---|---|---|
| P0 | Monorepo foundation | ⬜ | — | — |
| P1 | Schema package (`@atp/schema`) | ⬜ | — | — |
| P2 | Engine I — single-test execution | ⬜ | — | — |
| P3 | Engine II — suites/DAG/auth/matrix | ⬜ | — | — |
| P4 | Compile + CLI + sample corpus | ⬜ | — | — |
| P5 | Reporting renderers | ⬜ | — | — |
| P6 | Store — Postgres record + queue + artifacts | ⬜ | — | — |
| P7 | MCP server — sync surface | ⬜ | — | — |
| P8 | Worker + MCP Tasks — async lifecycle | ⬜ | — | — |
| P9 | Prompts + Insomnia migration | ⬜ | — | — |
| P10 | AuthN/Z + observability | ⬜ | — | — |
| P11 | CDK infra + DynamoDB adapter | ⬜ | — | — |

---

## Per-phase checklists & handoff notes

Tick items as they land. **Handoff notes** are for the next session: decisions made,
deviations from the plan, known gaps, exact next step. Keep them current — they are
the only memory that crosses sessions.

### P0 — Monorepo foundation
- [ ] pnpm workspace + root scripts (`build` `typecheck` `lint` `test` `compile`)
- [ ] `tsconfig.base.json` (strict) + per-package pattern
- [ ] Package stubs: schema, engine, reporting, store, mcp-server, cli, tools/compile
- [ ] Vitest wired; one passing test
- [ ] ESLint + Prettier
- [ ] CI workflow (install → typecheck → lint → test)
- [ ] `AGENTS.md` skeleton; README package map
- [ ] Exit criteria pass: `pnpm install && pnpm typecheck && pnpm lint && pnpm test`

**Handoff notes:** _none yet_

### P1 — Schema package
- [ ] `test.ts` (TestCase/Step/Request/Assertion/Extractor/Retry/Poll)
- [ ] `suite.ts` (Suite, node union, `needs`)
- [ ] `result.ts` (ExecutionResult/StepResult/AssertionResult)
- [ ] `manifest.ts` (Manifest/ManifestEntry, authored-vs-normalized split, fnHash)
- [ ] `config.ts` (fail-fast env schema)
- [ ] Matrix contract in test schema
- [ ] Zod → JSON Schema derivation for `params` + tests
- [ ] Unit tests: valid/invalid fixtures per schema

**Handoff notes:** _none yet_

### P2 — Engine I
- [ ] `define.ts` (`defineTest`, `defineEnv`)
- [ ] `variables.ts` (env/params/secrets/matrix scopes; nodes-bag designed)
- [ ] `http.ts` (undici: timing, timeout, AbortSignal, redirects)
- [ ] `assertions.ts` (all declarative ops + `fn`)
- [ ] `extract.ts` · [ ] `retry.ts` · [ ] `redact.ts`
- [ ] `runner.ts` (single test = one-node DAG)
- [ ] MockAgent test suite (happy, ops, retry, timeout, redact, cancel)

**Handoff notes:** _none yet_

### P3 — Engine II
- [ ] `defineSuite` / `useTest` / `useStep` / `defineAuth`
- [ ] `graph.ts` (topo sort, cycle detection)
- [ ] DAG runner (parallel branches, `{{nodes.X.var}}`, run timeout, cancel between nodes)
- [ ] `poll.untilAssertPasses`
- [ ] Auth providers: bearer, basic, api-key, oauth2-cc (cached), custom
- [ ] Matrix expansion → discrete executable units
- [ ] Tests incl. §7.2-style e2e suite on MockAgent

**Handoff notes:** _none yet_

### P4 — Compile + CLI + corpus
- [ ] `tools/compile`: discovery → normalize → `dist/manifest.json` (+gitSha, manifestHash)
- [ ] Friendly compile errors (file + reason)
- [ ] CLI: `atp compile` / `list` / `run` / `validate`
- [ ] Sample corpus (`tests/_shared/*`, identity, billing incl. one suite)
- [ ] Local mock SUT for offline runs
- [ ] `AGENTS.md`: add-a-test recipe + conventions
- [ ] CI runs `pnpm compile`
- [ ] Exit: new dummy test appears in manifest with no other change

**Handoff notes:** _none yet_

### P5 — Reporting
- [ ] `markdown.ts` · [ ] `summary.ts` (llm_summary + likely-cause heuristic)
- [ ] `html.ts` (self-contained) · [ ] `junit.ts` · [ ] `trace.ts`
- [ ] Golden-file tests (pass/fail/retried/cancelled/long-suite fixtures)
- [ ] CLI `--report md|html|junit`

**Handoff notes:** _none yet_

### P6 — Store
- [ ] Drizzle schema + migrations (§16.1 tables + stage-1 `tasks` table)
- [ ] `queue.ts` (enqueue/claim SKIP LOCKED/heartbeat/reaper/cancel flag)
- [ ] `TaskStateStore` interface + `PostgresTaskStore`
- [ ] `ArtifactStore` interface + S3 + local-fs implementations
- [ ] `runs.ts` history writes + `list_runs` query
- [ ] `docker-compose.dev.yml`
- [ ] Integration tests: concurrent claim safety, reaper requeue, migrations-from-empty

**Handoff notes:** _none yet_

### P7 — MCP server (sync)
- [ ] Stateless Streamable HTTP via Hono; `/healthz` `/readyz`; fail-fast config
- [ ] Manifest load at boot (+dev hot-reload)
- [ ] Tools: `list_tests` `describe_test` `run_test`(inline) `get_report` `list_runs`
- [ ] Resources: `test://catalog` `test://{id}` `run://{id}/report.md` `run://{id}/trace.json`
- [ ] Inline runs persist history + artifacts
- [ ] In-memory MCP client integration tests; `pnpm dev:server`

**Handoff notes:** _none yet_

### P8 — Worker + Tasks (async)
- [ ] `tasks.ts` lifecycle glue (SEP-1686 mapping onto TaskStateStore + queue)
- [ ] `worker.ts` (claim loop, heartbeat, progress, artifacts, terminal state)
- [ ] Tools: `run_suite` `run_selection` auto-task `run_test`; `get_run` `get_run_result` `cancel_run`
- [ ] Cancellation end-to-end (flag → AbortSignal)
- [ ] Reaper wired; idempotency keys
- [ ] Integration tests: complete / cancel / crash-requeue / non-Task client path
- [ ] `pnpm dev:worker`; two-process dev flow documented

**Handoff notes:** _none yet_

### P9 — Prompts + migration
- [ ] Prompts: `import_insomnia_collection` `author_new_test` `triage_failure` `generate_suite` `regenerate_reports`
- [ ] `atp import` deterministic scaffolder (§13.1 mapping) + fixture tests
- [ ] Golden-master parity helper
- [ ] `MIGRATION.md` template; `regenerate_reports` impl
- [ ] `AGENTS.md` finalized (recipes + full surface reference)

**Handoff notes:** _none yet_

### P10 — Auth + observability
- [ ] OAuth 2.1 (`jose`, RFC 9728/8707), `test:read`/`test:run` scopes, dev-off flag
- [ ] Audit log on run-invoking calls
- [ ] Pino everywhere with runId/taskId/traceId/nodeId + log redaction
- [ ] OTel tracing (MCP call → run → SUT call spans)
- [ ] Metrics incl. `queue_depth` for autoscaling
- [ ] Tests: scope rejection, audit rows, correlation ids

**Handoff notes:** _none yet_

### P11 — Infra + DynamoDB
- [ ] Dockerfile (MODE=server|worker, tini, graceful shutdown)
- [ ] CDK stacks: network / data / ecs / observability
- [ ] `DynamoTaskStore` + idempotency adapter + config-based store selection
- [ ] (Optional) `RunTask` escape hatch for very long runs
- [ ] `cdk synth` in CI; `docs/deploy.md` runbook

**Handoff notes:** _none yet_

---

## Session log

Append one row per session. Newest at the bottom.

| Date | Session | Phase(s) touched | Outcome | Commit(s) |
|---|---|---|---|---|
| 2026-07-22 | planning | — | Plan + tracker created | _(this commit)_ |

## Deferred / discovered work

Items found mid-session that belong to a later phase — park them here instead of
doing them out of order.

- _none yet_
