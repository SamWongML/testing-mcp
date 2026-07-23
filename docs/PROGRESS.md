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
| P0 | Monorepo foundation | ✅ | 2026-07-23 | ✅ |
| P1 | Schema package (`@atp/schema`) | ✅ | 2026-07-23 | ✅ |
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
- [x] pnpm workspace + root scripts (`build` `typecheck` `lint` `test` `compile`)
- [x] `tsconfig.base.json` (strict) + per-package pattern
- [x] Package stubs: schema, engine, reporting, store, mcp-server, cli, tools/compile
- [x] Vitest wired; one passing test
- [x] ESLint + Prettier
- [x] CI workflow (install → typecheck → lint → test)
- [x] `AGENTS.md` skeleton; README package map
- [x] Exit criteria pass: `pnpm install && pnpm typecheck && pnpm lint && pnpm test`

**Handoff notes:**
- **Typecheck strategy:** one root `tsconfig.json` drives `pnpm typecheck` (`tsc --noEmit`
  over `packages/*/src` + `tools/*/src`). Per-package `tsconfig.json` extends
  `tsconfig.base.json` for editors/future builds but isn't the authoritative check. This
  avoids adding `typescript` as a dep to every package. Base uses `moduleResolution:
  "Bundler"`, `verbatimModuleSyntax`, `isolatedModules`, `strict`,
  `noUncheckedIndexedAccess` — so use `import type` for type-only imports.
- **Cross-package imports:** internal packages expose `exports` → `./src/index.ts`, so no
  build is needed in dev/test. When P1's `@atp/engine` (or others) import `@atp/schema`,
  add `"@atp/schema": "workspace:*"` to that package's `dependencies` and run
  `pnpm install` to link it.
- **Vitest scope:** `vitest.config.ts` include is `packages/**/src/**/*.test.ts` +
  `tools/**/src/**/*.test.ts`. The future `tests/` corpus is also `*.test.ts` but is
  intentionally NOT matched — keep platform unit tests under `src/`.
- **Prettier ignores `**/*.md`** (authored docs). CI (`.github/workflows/ci.yml`) runs
  install → typecheck → lint → test; `format:check` is a local convenience, not in CI.
- **Toolchain:** Node 22, pnpm 10.33 pinned via `packageManager`. `zod` is NOT installed
  yet — P1 adds `zod@^4` to `@atp/schema`. pnpm ignores esbuild's build script (warning is
  benign; `tsx`/`vitest` work).
- **Exact next step (P1):** implement `@atp/schema` — `test.ts`, `suite.ts`, `result.ts`,
  `manifest.ts`, `config.ts` with the authored-vs-normalized split and `fnHash` modeled;
  add `zod@^4`; write valid/invalid fixture tests + the Zod→JSON-Schema derivation for
  `params`. Read plan §P1 and research §7 + §14.

### P1 — Schema package
- [x] `test.ts` (TestCase/Step/Request/Assertion/Extractor/Retry/Poll)
- [x] `suite.ts` (Suite, node union, `needs`)
- [x] `result.ts` (ExecutionResult/StepResult/AssertionResult)
- [x] `manifest.ts` (Manifest/ManifestEntry, authored-vs-normalized split, fnHash)
- [x] `config.ts` (fail-fast env schema)
- [x] Matrix contract in test schema
- [x] Zod → JSON Schema derivation for `params` + tests
- [x] Unit tests: valid/invalid fixtures per schema

**Handoff notes:**
- **Zod version:** `zod@^4` (resolved 4.4.3). Native `z.toJSONSchema()` is used for
  the `params` → JSON Schema derivation — no `zod-to-json-schema` dep needed. ISO
  timestamps use `z.iso.datetime()` (Zod-4 form, not the deprecated
  `z.string().datetime()`).
- **Authored vs normalized (ADR-003 split):** the exported Zod schemas describe the
  **normalized/serializable** IR (what lands in the manifest). Authored, function-
  carrying forms are TypeScript-only types alongside them: `AuthoredTestCase`/
  `AuthoredStep`/`AuthoredAssertion` (`test.ts`), `AuthoredSuite`/`AuthoredSuiteNode`
  = `UseTestNode | UseStepNode | InlineNode` (`suite.ts`), and `ParamsBuilder`
  (`(zod) => z.ZodType`). P2's `defineTest`/P4's normalizer consume the authored types
  and emit normalized IR.
- **fn escape hatch:** normalized assertion is `declarativeAssertionSchema |
  fnAssertionSchema`, where `fnAssertionSchema = { fnHash, message? }`. The **engine**
  (P2) computes the actual content hash from the authored `fn`; the schema just models
  the marker. The manifest carries no functions.
- **Unified node model:** a test's `steps` and a suite's `nodes` are the **same**
  `stepSchema` (which includes `needs: string[]` default `[]`). `suiteNodeSchema` is an
  alias of `stepSchema`; the manifest entry's `nodes` reuses it. So both tests and
  suites normalize to one array-of-nodes shape.
- **`env` in normalized IR:** modeled as an optional `Record<string, unknown>` on
  `testCaseSchema`/`suiteSchema` (a resolved env object). Matrix-derived env (§7.3, an
  authored `env: (m) => …` function) is expanded per-cell by the engine in P3 — not
  representable as a single normalized object, deliberately left to P3.
- **ExecutionResult (designed for all 4 P5 renderers):** `result.ts` carries per-step
  redacted request/response snapshots, assertion detail with `expected`/`actual`
  (drives the P5 likely-cause heuristic), `timingMs`, `attempts`, `error`, run
  `metrics`, and `manifestHash`/`gitSha` (§21). Status enums are split: run-level
  `executionStatusSchema` = passed|failed|cancelled|errored (terminal only — MCP Task
  in-flight states map at the server layer, P8); step-level adds `skipped`.
- **`SCHEMA_VERSION`** = `"1.0"` (exported from `manifest.ts`); `manifestSchema`
  defaults `schemaVersion` to it. Bump when the normalized IR contract changes.
- **Test-script scoping:** `@atp/schema` has `"test": "vitest run --root ../..
  packages/schema/"` so `pnpm --filter @atp/schema test` runs only schema tests against
  the single root `vitest.config.ts` (pnpm sets cwd to the package; `--root ../..`
  points vitest back at the repo root, positional filters to the package path). Root
  `pnpm test` still runs everything (40 tests).
- **Exact next step (P2):** implement `@atp/engine` single-test execution. Add
  `"@atp/schema": "workspace:*"` to `packages/engine/package.json` deps + `pnpm
  install`. Import authored types (`AuthoredTestCase`, `AuthoredAssertion`, …) for
  `defineTest`/`defineEnv`; produce `ExecutionResult` (validate with
  `executionResultSchema`). The engine owns fn-hashing, templating, undici HTTP, and
  redaction. Read plan §P2 and research §10 + §7.1.

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
| 2026-07-23 | P0 | P0 | Monorepo foundation: workspace, 7 package stubs, strict tsconfig, Vitest (1 test), ESLint+Prettier, CI, AGENTS.md. Exit criteria green. | _(this commit)_ |
| 2026-07-23 | P1 | P1 | `@atp/schema`: test/suite/result/manifest/params/config schemas (Zod 4) + authored-vs-normalized split, fnHash marker, matrix, `z.toJSONSchema` params derivation, `SCHEMA_VERSION`. TDD, 40 tests. Exit criteria green. | _(this commit)_ |

## Deferred / discovered work

Items found mid-session that belong to a later phase — park them here instead of
doing them out of order.

- _none yet_
