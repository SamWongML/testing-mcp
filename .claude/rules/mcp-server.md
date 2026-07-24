---
paths:
  - "packages/mcp-server/**/*.ts"
---

# `@atp/mcp-server` — the MCP surface

## The two invariants that shape every file here

- **Stateless request path** (ADR-002). No cross-request memory. `http.ts` builds a **fresh**
  `McpServer` + `WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })`
  **per request**. Anything that must outlive a request goes in `ServerContext` (injected at
  boot) or in the store — never in a module-level mutable. Because there is no session, a
  `runId` must be resolvable from durable state alone (hence the `{env}/index/run/{runId}`
  pointer object in `run-store.ts` — `ArtifactStore` has no `list()`).
- **Additive tool surface.** Never rename or remove a tool or a field; add optional fields.
  Existing clients must keep working across phases.

## Layout

- `context.ts` — `ServerContext`, the composition root (manifest, sourceRoot, artifacts,
  artifactEnv, optional `db`, optional `auth`). Injected, never per-request.
- `server.ts` — `buildMcpServer(ctx)`: pure/stateless registration of tools + resources.
- `tools.ts`, `resources.ts` — the surface itself.
- `bootstrap.ts` — `buildContext(config)`: manifest from `MANIFEST_PATH` (schema-validated)
  else `compile({ root: TESTS_ROOT })`. **Does not create the db** — `main.ts` injects it, so
  `buildContext` stays offline and free of pool lifecycle (mirrors the test DI seam).
- `main.ts` — `MODE=server` entrypoint (`pnpm dev:server`, `tsx watch`).
- `testkit.ts` — shared test seam: `makeTestContext`, `connectClient` (in-memory transport
  pair), `startHttpServer`, `startTestSut`, `makeTestDb`/`pgAvailable` (skips offline).

## Working here

- The engine stays pure: import `@atp/engine`, never the reverse.
- Config lives in `@atp/schema`'s `configSchema` — add optional fields **there** first, then
  consume (ADR-003).
- **The MCP SDK Task API is experimental — verify against the installed SDK `.d.ts` under
  `node_modules/@modelcontextprotocol/` or Context7, not memory.**
- Tests here use the in-memory client from `testkit.ts`; db-backed paths skip without
  `ATP_TEST_DATABASE_URL`.

TypeScript strict + ESM (`verbatimModuleSyntax`, `isolatedModules`,
`noUncheckedIndexedAccess`).
