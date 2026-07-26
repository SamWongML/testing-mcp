---
paths:
  - "packages/mcp-server/**/*.ts"
---

# `@atp/mcp-server` — the MCP surface

## The two invariants that shape every file here

- **Stateless request path.** No cross-request memory. `http.ts` builds a **fresh**
  `McpServer` + `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })`
  **per request**. Anything that must outlive a request goes in `ServerContext` (injected at
  boot) or in the store — never in a module-level mutable. Because there is no session, a
  `runId` must be resolvable from durable state alone (hence the `{env}/index/run/{runId}`
  pointer object in `run-store.ts` — `ArtifactStore` has no `list()`).
- **Additive tool surface.** Never rename or remove a tool or a field; add optional fields.
  Existing clients must keep working across releases.

## The surface

Tests are *data*, so authoring a new test never needs a new tool. The surface is fixed:

- **Sync tools.** `list_tests` (catalog query) · `describe_test` (one entry's node graph + params
  schema) · `run_test` (sync verdict; auto-tasks a long-running test) · `get_report {runId, format}`
  (re-render a stored run: md/html/junit/json/summary) · `list_runs` (history).
- **Async tools** (need a run db). `run_suite` (an SEP-1686 Task) · `run_selection {tags}` (batch) ·
  `get_run`/`get_run_result`/`cancel_run` — mirror tools observing the same durable state as the Task.
- **Prompts** (`prompts/`, always registered). `import_insomnia_collection` · `author_new_test` ·
  `triage_failure` · `generate_suite` · `regenerate_reports`. Each renders a concrete instruction
  template over the real tools and CLI — edit the template, not each caller's prompt.
- **Resources** (`resources.ts`). `test://catalog` (the manifest) · `test://{id}` (one normalized
  entry) · `run://{runId}/report.md` · `run://{runId}/trace.json`.

## Authorization has two layers — know which one covers your code

`guardScope` in a handler covers **only** requests the SDK routes through one of our callbacks:
`tools/call` and `resources/read`. It does **not** and **cannot** cover the SEP-1686 `tasks/*`
family (`tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel`): the SDK's `Protocol`
registers its own generic handlers for those as soon as a `taskStore` is configured, dispatching
straight into `SdkTaskStore` without a callback, and `TaskStore` is never given the caller's
`AuthInfo`. Those methods are gated **by method name in `http.ts`** (`TASK_METHOD_SCOPES` +
`requiredScopesFor` → 403 `insufficient_scope`).

**So:** adding a tool ⇒ add `guardScope` in its handler. Adding or enabling any *protocol-level*
method the SDK handles for us ⇒ add it to `TASK_METHOD_SCOPES`, because no handler guard will run.
This bypass shipped once (any zero-scope token could cancel any run); `auth-http.test.ts` holds the
regression tests.

## Layout

- `context.ts` — `ServerContext`, the composition root (manifest, sourceRoot, artifacts,
  artifactEnv, optional `db`, engine `auth` providers, and the optional `authn`/`logger`/
  `telemetry`). Injected, never per-request.
- `server.ts` — `buildMcpServer(ctx)`: pure/stateless registration of tools + resources;
  enables the async task surface + `SdkTaskStore` + Tasks capability when `ctx.db` is present.
- `tools.ts`, `resources.ts` — the sync surface itself. Every handler takes `extra` and calls
  `guardScope(ctx, extra, SCOPES.READ|RUN)`; the four run tools also `auditRun(...)`.
- `auth.ts` — the pure OAuth core: `parseBearerToken`, `SCOPES`, `assertScope`/
  `ScopeError`, RFC 9728 `protectedResourceMetadata` + `wwwAuthenticate`, `createAuthenticator`
  (jose JWT verify: signature/issuer/RFC 8707 audience/expiry → SDK `AuthInfo`). Side-effect free.
- `guard.ts` — handler-side `guardScope` / `auditRun` / `principalOf`; both the scope check and
  the audit write **no-op** off the auth/db path, so handlers run unchanged in dev/test.
  `redactAuditParams` masks secret-shaped **keys** before an audit row is written (the engine's
  `redact()` is value-based and cannot cover an arbitrary caller-supplied params bag).
- `logging.ts` — `createLogger` (Pino JSON + `REDACT_PATHS` secret scrub; `child({runId,…})`).
- `telemetry.ts` — `initTelemetry` (OTel providers + undici auto-instrumentation for SUT spans),
  `withSpan` (active-span wrapper), `RunMetrics` (`runs_total`/`queue_depth`/…). Exporters
  injectable (console default, in-memory in tests). **The engine stays pure** — SUT spans come
  from undici's diagnostics_channel, never an engine OTel import.
- `execute.ts` — `executeEntry`: the shared test/suite executor (signal + `onProgress` +
  `runId`) used by both the inline `run_test` and the worker.
- `tasks.ts` — async lifecycle glue over the queue + `PostgresTaskStore`: `submitRun`
  (atomic create-task + enqueue, idempotent), `getRun`/`getRunResult`/`cancelRun`.
- `worker.ts` — the `MODE=worker` claim→execute→reap loop (`pnpm dev:worker`).
- `sdk-tasks.ts` — `SdkTaskStore`: bridges the experimental MCP Tasks protocol onto the same
  durable rows (keyed `runId == taskId`).
- `task-tools.ts` — `run_suite` (task-augmented) + `run_selection` + the
  `get_run`/`get_run_result`/`cancel_run` mirror tools.
- `bootstrap.ts` — `buildContext(config)`: manifest from `MANIFEST_PATH` (schema-validated)
  else `compile({ root: TESTS_ROOT })`. **Does not create the db** — `main.ts`/`main-worker.ts`
  inject it, so `buildContext` stays offline and free of pool lifecycle (mirrors the test seam).
- `main.ts` / `main-worker.ts` — `MODE=server` / `MODE=worker` entrypoints
  (`pnpm dev:server` / `pnpm dev:worker`, `tsx watch`).
- `testkit.ts` — shared test seam: `makeTestContext`, `connectClient` (in-memory transport
  pair), `startHttpServer`, `startTestSut`, `makeTestDb`/`pgAvailable` (skips offline).

## Working here

- The engine stays pure: import `@atp/engine`, never the reverse.
- Config lives in `@atp/schema`'s `configSchema` — add optional fields **there** first, then consume.
- **The MCP SDK Task API is experimental — verify against the installed SDK `.d.ts` under
  `node_modules/@modelcontextprotocol/` or Context7, not memory.**
- Tests here use the in-memory client from `testkit.ts`; db-backed paths skip without
  `ATP_TEST_DATABASE_URL`.

TypeScript strict + ESM (`verbatimModuleSyntax`, `isolatedModules`,
`noUncheckedIndexedAccess`).
