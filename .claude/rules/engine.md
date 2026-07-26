---
paths:
  - "packages/engine/**/*.ts"
---

# `@atp/engine` — the execution core

**The engine stays pure.** Never import MCP or AWS code into `@atp/engine`. It consumes the
authored/normalized IR from `@atp/schema` and returns a typed `ExecutionResult`; everything
else (transport, persistence, rendering) lives outside.

## Execution model (`runner.ts`, `suiteRunner.ts`)

A **test** runs its steps sequentially — a failed/errored step skips the rest, a cancel
cascades. A **suite** is a topologically-scheduled **DAG** over the same per-node runner, with
independent branches under a bounded concurrency limit (default 8); a node whose dependency
did not pass is `skipped`.

Each node: **resolve templates → apply auth → send (undici) → assert → extract → publish**,
wrapped in per-step retry and eventual-consistency polling, snapshotting a redacted
request/response.

- **Retry vs. poll are different axes.** Retry owns transport; poll
  (`poll.untilAssertPasses`) owns the assertion-retry axis and suppresses `assertion` in
  `retryOn`. Each send is bounded by the step `timeoutMs`, the poll loop by `maxMs`.
- **Matrix expansion is plan-time** (`matrix.ts`); the runner executes one cell at a time.

## Template variable scopes (`context.ts`)

`{{env.*}}`, `{{params.*}}`, `{{secrets.*}}`, `{{matrix.*}}`, `{{nodes.<id>.<var>}}`
(deterministic cross-node addressing), and `{{vars.*}}` — a flat last-writer-wins bag,
**reliable only within a single dependency chain, not across parallel branches**. Prefer
`{{nodes.<id>.<var>}}` when a value crosses branches.

## Invariants enforced here

- **Redact before persist** — any request/response snapshot passes `redact()` first. This
  includes the query string, not just headers and body: a secret-sourced api-key in `query`
  must not leak at rest. Redaction is *value*-based: it masks the values in the `secrets` bag
  wherever they appear, which is why that bag comes from prefixed `ATP_SECRET_*` vars only —
  admitting the whole environment would blank unrelated substrings out of reports.
- **Auth providers are built from data** — `buildAuthRegistry` turns an entry's
  `AuthProviderSpec[]` into applicable providers. Nothing function-carrying: a provider that
  took a callback could not live in the manifest, so the drivers forward `entry.auth` and the
  engine constructs. An unknown `type` throws rather than degrading to a no-op that would send
  the request unauthenticated.
- **`fnHash`** is computed here from the authored `fn`; `@atp/schema` only models the marker.
- Representation changes land in `@atp/schema` **first**, then this package adapts.

## Conventions

Unit tests sit beside their source as `packages/engine/src/**/*.test.ts` — that is what
`vitest.config.ts` matches.
