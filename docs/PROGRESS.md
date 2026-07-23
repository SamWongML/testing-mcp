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
| P2 | Engine I — single-test execution | ✅ | 2026-07-23 | ✅ |
| P3 | Engine II — suites/DAG/auth/matrix | 🔄 | 2026-07-23 | — |
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
  the `params` → JSON Schema derivation — no `zod-to-json-schema` dep needed.
  `deriveParamsSchema` passes `io: "input"` so a param with a `.default()` is **optional**
  in the derived tool-input schema (the client may omit it) — that's the schema
  `describe_test` advertises. ISO timestamps use `z.iso.datetime({ offset: true })`
  (Zod-4 form; `offset:true` accepts `+02:00`-style stamps, e.g. Postgres `timestamptz`,
  as well as `Z`).
- **IR integrity refinements:** `testCaseSchema.steps`, `suiteSchema.nodes`,
  `manifestEntrySchema.nodes`, and `manifestSchema.entries` all `.refine(uniqueById, …)`
  (helper in `util.ts`) — ids are the addressing keys for `needs` edges,
  `{{nodes.X.*}}` templates, and manifest lookup, so duplicates are rejected at parse
  time rather than silently mis-binding downstream.
- **`attempts` bound:** `stepResultSchema.attempts` is `nonnegative` (default 1) so a
  `skipped` step can honestly record `attempts: 0` instead of a fabricated 1.
- **`isLongRunning`:** authored `AuthoredTestCase`/`AuthoredSuite` expose an optional
  `isLongRunning?: boolean` so the P4 normalizer has an explicit source for the manifest
  field (else it infers from `timeoutMs`).
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
- [x] `define.ts` (`defineTest`, `defineEnv`)
- [x] `variables.ts` (env/params/secrets/matrix scopes; nodes-bag designed)
- [x] `http.ts` (undici: timing, timeout, AbortSignal, redirects)
- [x] `assertions.ts` (all declarative ops + `fn`)
- [x] `extract.ts` · [x] `retry.ts` · [x] `redact.ts`
- [x] `runner.ts` (single test = one-node DAG)
- [x] MockAgent test suite (happy, ops, retry, timeout, redact, cancel)

**Handoff notes:**
- **Deps added:** `@atp/engine` now depends on `@atp/schema` (workspace), `undici@^7`
  (resolved 7.28), and `zod@^4`. `undici`'s `request` uses the **global dispatcher**,
  so tests intercept with `MockAgent` + `setGlobalDispatcher` — no live network.
- **RunContext (`context.ts`)** is the single scoped var bag: `env/params/secrets/`
  `matrix/vars/nodes`. `nodes[id][var]` holds a node's published extracts — the P3
  DAG runner reuses this exact shape for `{{nodes.X.var}}`. `createRunContext`
  defaults every scope so lookups never crash. `EngineResponse = {status,headers,body,
  timingMs}` is what assertions/extracts/`fn` address; `ResolvedRequest = RequestSpec`.
- **Templating (`variables.ts`):** two modes — *whole-value* (`"{{params.count}}"`
  → raw typed value, preserving number/bool/object) and *interpolation*
  (`"{{env.baseUrl}}/x"` → stringified in place). Resolution is **recursive** (bounded
  depth 16), so a param default of `"{{secrets.QA_PASSWORD}}"` resolves through to the
  secret. Unknown scope / unresolved var **throw** (surfaces authoring bugs); the
  runner treats a throw during request resolution as a non-retryable `errored` step.
- **Assertions (`assertions.ts`):** all ops implemented — `eq/neq` (deepEqual),
  `gt/lt` (numeric coercion), `contains` (string substr / array membership),
  `matches` (regex), `isString/isNumber`, `jsonSchema` (minimal validator in
  `jsonschema.ts`: type/properties/required/items/enum/const), `jsonpath` (minimal
  child+index evaluator in `jsonpath.ts`: `$.a.b`, `$.a[0]`, `$['a']` — no
  wildcards/descent/filters yet). `fn` escape hatch runs the real predicate against
  the response; a throw → failed assertion. Results carry `op/path/expected/actual`
  for the P5 likely-cause heuristic (absent for `fn`).
- **Retry (`retry.ts`):** `withRetry(policy, run, {signal})` — `run` reports which
  `RetryOn` conditions it hit; retries while `attempt <= max` and a hit is in
  `policy.on`, honoring `backoffMs` (abortable sleep) and stopping on `signal.aborted`.
  `attempts` counts total tries (1 + retries).
- **Redaction (`redact.ts`):** masks sensitive header **keys** wholesale
  (authorization, cookie, set-cookie, x-api-key, proxy-authorization) and any secret
  **value** (from `ctx.secrets`) wherever it appears in headers or the string-walked
  body. Applied to both request and response snapshots before they enter a StepResult.
- **HTTP (`http.ts`):** JSON body auto-serialized (+`content-type` if unset), query
  appended via `URL`, timing via `performance.now()`. Timeout = `AbortSignal.timeout`
  combined with the caller signal via `AbortSignal.any`. **Redirect policy + connection
  pooling are undici-v7 dispatcher concerns** (the `redirect` interceptor / a `Pool`),
  not per-request options — deferred until a real dispatcher is wired (note: the P2
  checklist line said "redirects" but v7 moved this off `request`).
- **Runner (`runner.ts`):** `runTest(test, {params,env,secrets,signal,runId,envName,`
  `manifestHash,gitSha})` → validated `ExecutionResult`. Steps run **sequentially**
  (single test = one-node-at-a-time); each publishes extracts to `ctx.nodes[id]` +
  `ctx.vars`. On a `failed`/`errored` step the remaining steps are marked `skipped`
  (they'd reference unpublished vars); on cancellation the rest are `cancelled`
  (`attempts: 0`, honestly not-run). Run status precedence: cancelled > errored >
  failed > passed. `attemptStep` is the **reusable node runner** for P3's DAG.
  `resolveParams` runs the authored `params` builder (`test.params(z).parse`) so
  defaults apply; invalid params → `errored` result (not a throw).
- **fn-hashing (`fnHash.ts`):** `hashFn(fn)` = `sha256:<hex of fn.toString()>` — the
  engine owns this; the P4 normalizer will call it to turn authored `fn` predicates
  into the manifest's `fnHash` markers. Not needed by the runner (it holds the real fn).
- **Exit criteria:** `pnpm --filter @atp/engine test` green (54 tests); full gate
  `typecheck + lint + test` green (100 tests total). The §7.1 login demo runs on
  MockAgent and produces an `ExecutionResult` that `executionResultSchema` parses.
- **Post-review hardening (completeness + simplicity pass):** added tests for the
  previously-unexercised runtime paths — retry on `network`/`4xx`/`assertion` (not just
  `5xx`), **in-flight** AbortSignal cancellation (abort after the request starts, vs the
  pre-abort case), abortable retry backoff, response-side sensitive-header redaction,
  and the `matches` invalid-regex / `gt`/`lt` non-numeric branches. Simplifications:
  extracted one shared deep-string walker `mapDeepStrings` in `util.ts` (was duplicated
  as `resolveValue` in `variables.ts` + `redactDeep` in `redact.ts`), dropped a trivial
  `redactString` wrapper, narrowed `applyOp` to `Exclude<AssertionOp,"jsonpath">` (the
  jsonpath case is handled upstream), and flattened the scope→bag ternary in
  `variables.ts` to an allow-list `Set`.
- **Explicitly deferred to P3 (schema exists, engine support pending):** `poll`
  (`step.poll` is ignored today), suites/DAG parallelism, matrix expansion, real auth
  providers (`authRef`/`applyAuth` — no auth applied yet), matrix-derived `env`.
- **Exact next step (P3):** implement `@atp/engine` composition — `defineSuite`/
  `useTest`/`useStep`/`defineAuth`, `graph.ts` (topo sort + cycle detection), the DAG
  runner (reuse `attemptStep`; bounded parallelism; cancel between nodes),
  `poll.untilAssertPasses`, auth providers, and matrix expansion. Read plan §P3 and
  research §12, §7.2–7.3, §10.2–10.3.

### P3 — Engine II
- [ ] `defineSuite` / `useTest` / `useStep` / `defineAuth`
- [x] `graph.ts` (topo sort, cycle detection)
- [x] DAG runner (parallel branches, `{{nodes.X.var}}`, run timeout, cancel between nodes)
- [ ] `poll.untilAssertPasses`
- [ ] Auth providers: bearer, basic, api-key, oauth2-cc (cached), custom
- [ ] Matrix expansion → discrete executable units
- [ ] Tests incl. §7.2-style e2e suite on MockAgent

**Handoff notes:**
- **`graph.ts` (done):** `topoSort(nodes: {id, needs?}[]) → string[]` (Kahn's algorithm,
  ties broken by authored order → deterministic). Validates the graph as it sorts and
  **throws** on: duplicate node ids, a `needs` edge pointing at an unknown node, and
  cycles (error names the nodes still in the cycle). A missing `needs` is treated as no
  deps. This is the compile-time cycle/edge check §12 promises (P4's compile step will
  call it; the DAG runner also uses it to order execution). Pure + framework-free — takes
  the minimal `GraphNode` shape (`id` + optional `needs`), not the full `Step`, so it works
  on authored *or* normalized nodes. 7 tests in `graph.test.ts`.
- **`defineSuite`/`useTest`/`useStep` + suite normalizer (done):** authoring helpers in
  `define.ts` (typed identity + cheap guards, mirroring `defineTest`). `useTest(test,
  {params, needs})` / `useStep(step, {with, needs})` embed **by reference** (§12) — they
  carry the actual object, not an id.
  - **Schema change (schema-first):** `schema/src/suite.ts` `UseTestNode` now carries
    `test: AuthoredTestCase` (was `testId: string`), `UseStepNode` carries
    `step: AuthoredStep` (was `stepId`), and `InlineNode = Omit<AuthoredStep,"id"> &
    {id?}` (the `nodes` map key supplies the id, so inline nodes omit it). Only schema
    self-referenced these types — no other consumers broke.
  - **`suite.ts` `planSuite(suite) → PlanNode[]`:** flattens `AuthoredSuite.nodes`
    (`Record<id, AuthoredSuiteNode>`) into an ordered executable plan. Each `PlanNode` =
    `{ id, needs, step: AuthoredStep, params }`: map key → `id` (and re-keys the step's
    id to it), `needs` carry over, and `params` is the node's **own** `{{params.*}}`
    scope — a `useTest` node resolves its reused test's params (defaults applied via the
    shared `resolveParams`), a `useStep` node exposes its `with` bag, an inline node gets
    `{}`. Ordering + cycle/edge validation delegate to `topoSort`. **Limitation:** a
    `useTest` of a *multi-step* test throws for now (single-step tests — the documented
    `login` pattern — only). 10 tests in `suite.test.ts`.
  - **`params.ts` (extracted):** `resolveParams(test, input)` moved out of `runner.ts`
    (which now imports it) so the suite normalizer shares it. No behavior change.
  - **Post-review hardening (completeness + simplicity pass, 2 subagents):** both agents
    confirmed the gate green and found no blockers/majors. Applied: (a) `toPlanNode` now
    throws a clear `unknown node kind` error instead of silently treating any non-`test`
    `use` value as a step (was a request-less-step fallthrough on untyped/JS input);
    (b) `useTest` param failures are wrapped as `node "<id>": invalid params: …` (was a
    raw ZodError, unlike the runner's friendly message); (c) hoisted the repeated
    `needs` local in `toPlanNode`. Added 7 tests for previously-uncovered paths: inline
    `needs` default `[]`, `useStep` with no opts, a **template param default surviving to
    run time** (load-bearing), authored-order tie-break with 3+ independents, unknown-`needs`
    via `planSuite`, the unknown-kind guard, and the wrapped param error. Nits left as-is
    (cycle error may name downstream nodes; duplicate `needs` on one node is benign).
- **DAG runner (`runSuite`, done):** `runSuite(suite, opts) → ExecutionResult`
  (kind: "suite") in `runner.ts`. Flattens via `planSuite`, then `scheduleNodes` runs the
  topo-ordered `PlanNode[]` as a DAG: a node fires once all its `needs` have **settled and
  passed**, with up to `opts.concurrency` (default 8) nodes in flight — independent
  branches run in parallel. Readiness keys off a `results` map (completed) while a separate
  `started` set guards relaunch, so an **in-flight node never looks "settled"** to its
  dependents (else they'd prematurely skip). Each node gets its **own** `RunContext.params`
  (from `PlanNode.params`) via a shallow `{ ...baseCtx, params }` spread that **shares**
  the suite-wide `env`/`secrets`/`nodes`/`vars` references — so extracts published to
  `ctx.nodes[id]` accumulate across parallel branches and `{{nodes.X.var}}` resolves
  everywhere (the diamond test proves it by asserting merge's resolved request body).
  - **Failed-dep cascade:** a node whose dependency didn't pass is `skipped` (never
    requested — the skip test omits the `/d` intercept to prove that); `depsPassed`
    cascades so a skipped node's own dependents skip too.
  - **Cancellation:** once `baseCtx.signal` aborts (caller cancel *or* run-timeout), every
    not-yet-started node is `cancelled`; an in-flight node aborts via the existing
    request-abort path (`attempts: 1`), pre-started nodes get `attempts: 0`. Run status
    then computes to `cancelled` (precedence).
  - **Per-run `timeoutMs` (suite-level = whole-run budget):** `AbortSignal.timeout(ms)`
    combined with the caller signal via `AbortSignal.any`. If the timeout signal **alone**
    fired the run is forced to `errored` with an "exceeded timeoutMs" message (its nodes
    still read as `cancelled`); a caller-cancel takes precedence and stays `cancelled`.
    NOTE: this is the whole-run budget, **not** a per-step fallback — suite nodes use their
    own `step.timeoutMs` (or none); runStep is called with `fallbackTimeoutMs` undefined.
  - **Refactor (the P3 (2/n) "Watch"):** `attemptStep`/`runStep` no longer take a `test`;
    they take `(step, ctx, secretValues, fallbackTimeoutMs?)` and read
    `step.timeoutMs ?? fallbackTimeoutMs`. `runTest` passes `test.timeoutMs`; `runSuite`
    passes nothing. `finalize` generalized to `kind: "test" | "suite"`. Both runners stay
    in `runner.ts` so the private node runner isn't re-exported; only `runSuite` is added
    to the public surface (via `export * from "./runner"`).
  - 11 tests in `suiteRunner.test.ts` (89 engine / 135 total): §7.2 refund chain, diamond
    DAG (parallel branches + merge), failed-dep skip + independent branch, cyclic→errored
    (no throw), pre-abort cancel, mid-flight cancel, run-timeout→errored, plus the
    review-pass adds: `concurrency:0` no-hang, `concurrency:1` serialization (timing lower
    bound), multi-`need` partial-skip cascade, and suite-level secret redaction.
- **Post-review hardening (completeness + simplicity pass, 2 subagents):** both confirmed
  the gate green and the design sound (no Blockers). Applied fixes: **(Major)** clamped
  `concurrency` — `opts.concurrency ?? DEFAULT` didn't guard `0` (a valid number), and a
  `0` limit launched nothing so the run **hung forever**; now `> 0 ? floor : DEFAULT`.
  **(robustness)** added a rejection handler to the `runStep().then()` in `scheduleNodes`
  (records a synthetic `errored` node instead of hanging + desyncing `active`) — latent
  today since `attemptStep` catches its own throws, but the asymmetry with `runTest`
  (which awaits/propagates) made it a future foot-gun. **(simplicity)** extracted
  `collectSecretValues` (was byte-duplicated in both runners; the empty-string filter is
  load-bearing for redaction) and folded the shared options into `RunOptionsBase` (both
  `RunTestOptions`/`RunSuiteOptions` extend it). **Documented (not changed):** flat
  `{{vars.*}}` is last-writer-wins across parallel branches — `{{nodes.X.var}}` is the
  deterministic cross-node addressing (comment in `scheduleNodes`); a node with no
  `step.timeoutMs` and a suite with no `timeoutMs` relies on the server responding.
- **Exact next step: `poll.untilAssertPasses`.** Add polling for eventual-consistency
  endpoints (research §10.2–10.3): a step's `poll: { intervalMs, maxMs }` (already in the
  schema, currently **ignored** by `attemptStep`) re-sends and re-evaluates that step's
  assertions until they pass or the budget elapses — abortable sleep like `retry.ts`,
  honoring `ctx.signal`. Decide the retry×poll interaction (poll wraps the assert loop for
  a single logical attempt; retry still owns transport/5xx re-tries) and where the poll
  budget sits vs. the step/suite timeout. After that: auth providers (`defineAuth` +
  bearer/basic/api-key/oauth2-cc-cached/custom) and matrix expansion → discrete units.
  Read plan §P3 and research §10.2–10.3, §12, §7.3.

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
| 2026-07-23 | P2 | P2 | `@atp/engine` single-test execution: define/variables/http(undici)/assertions(all ops + fn)/extract/retry/redact/runner + fnHash. RunContext var bag + reusable node runner designed for P3. TDD, 46 engine tests (92 total). Exit criteria green. | _(this commit)_ |
| 2026-07-23 | P3 (1/n) | P3 | `graph.ts`: `topoSort` (Kahn, deterministic) with cycle + unknown-`needs` + duplicate-id validation — the §12 compile-time DAG check. TDD, 7 tests (61 engine / 107 total). P3 in progress. | _(this commit)_ |
| 2026-07-23 | P3 (2/n) | P3 | `defineSuite`/`useTest`/`useStep` (by-reference composition) + `planSuite` normalizer (authored node map → ordered `PlanNode[]`, per-node params scope). Schema-first: `UseTestNode`/`UseStepNode` carry the object; `InlineNode` id optional. Extracted shared `resolveParams`. TDD, 10 tests (71 engine / 117 total). | _(this commit)_ |
| 2026-07-23 | P3 (3/n) | P3 | DAG runner `runSuite`: `scheduleNodes` topo-schedules `PlanNode[]` with bounded parallelism (default 8), per-node `params` sharing suite-wide `nodes`/`vars` for cross-branch `{{nodes.X.var}}`, failed-dep→`skipped` cascade, cooperative cancel→`cancelled`, whole-run `timeoutMs` budget→`errored`. Refactored `attemptStep`/`runStep` off `test` (fallback-timeout param); `finalize` generalized to test\|suite. TDD, 7 tests (85 engine / 131 total). | _(this commit)_ |
| 2026-07-23 | P3 (3/n) review | P3 | Completeness + simplicity review (2 subagents). Fixed a `concurrency:0` infinite-hang (clamp to default), added a `runStep` rejection guard, extracted `collectSecretValues` + `RunOptionsBase`. +4 tests (89 engine / 135 total). Gate green. | _(this commit)_ |

## Deferred / discovered work

Items found mid-session that belong to a later phase — park them here instead of
doing them out of order.

- **Redirect policy + connection pooling (from P2):** undici v7 moved redirect
  following off `request` options onto a dispatcher `redirect` interceptor, and
  pooling onto a `Pool`. `http.ts` uses the global dispatcher today (fine for
  MockAgent + most SUT calls). Wire an explicit dispatcher with the `redirect`
  interceptor + pooling when a real deployment needs it (P10/P11 territory, or
  sooner if a test SUT requires following redirects).
- **Per-node params representation for P4 (from P3 review):** the engine's runtime
  `PlanNode` carries a per-node `params` bag, but the normalized `suiteNodeSchema`
  (= `stepSchema`) has no `params` field and `AuthoredSuite` has no `params` builder.
  So (a) `run_suite {params}` (research §8.2) has no wiring into individual nodes yet,
  and (b) P4's compile step must decide how each node's resolved `params`/`with`
  bindings land in the *serializable* manifest — most likely by resolving `{{params.*}}`
  into the node's request templates at normalize time (baking), since the manifest
  carries no params builder. Settle this before the compile step hard-codes an assumption.
