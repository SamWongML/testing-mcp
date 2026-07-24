---
paths:
  - "packages/store/**/*.ts"
---

# `@atp/store` — Postgres persistence, queue, artifacts

Drizzle over Postgres. `runs.ts` (history), `queue.ts` (claim/heartbeat/reap), `tasks.ts`
(`TaskStateStore` — the seam P11's `DynamoTaskStore` implements), `manifests.ts` (catalog
snapshot), `artifacts.ts` (`ArtifactStore` interface + `LocalArtifactStore`; `S3ArtifactStore`
is P11).

## Testing — read this before running or writing tests here

Integration tests are **gated on `ATP_TEST_DATABASE_URL`** (`db/test-db.ts`). Unset ⇒ the
suites `describe.skipIf` out so `pnpm test` stays green offline; the pure unit tests
(`artifacts`, `artifactKey`) always run. **A green `pnpm test` with no DB does not mean the
store paths ran** — say so rather than claiming verification.

```bash
docker compose -f docker-compose.dev.yml up -d          # Postgres 16
ATP_TEST_DATABASE_URL=postgres://… pnpm --filter @atp/store test
```

`makeTestDb()` creates a throwaway Postgres **schema** (namespace), points the pool's
`search_path` at it, migrates, and drops it on `close()` — per-suite isolation over one shared
database, so concurrency tests use a real pool. CI sets `ATP_TEST_DATABASE_URL` on the
`pnpm test` step only.

## Conventions

- **Migrations are hand-written SQL** under `src/db/migrations/` (`0000_init.sql`), not
  `drizzle-kit generate`. `schema.ts` ↔ the SQL must be kept in sync **by hand** — a Drizzle
  column with no matching DDL typechecks fine and fails at runtime.
- **Ids are `text`**, not uuid columns.
- **Redact before persist** — anything written here already passed the engine's `redact()`;
  never add a write path that bypasses it.
- **Every run records `manifestHash` + `gitSha`.** `git_sha` is denormalized onto `runs` so a
  run row is self-describing without the `manifests` table.
- Queue claims use `FOR UPDATE SKIP LOCKED`; the reaper requeues expired leases.

## Code conventions

TypeScript strict + ESM. The base tsconfig sets `verbatimModuleSyntax`, `isolatedModules`, and
`noUncheckedIndexedAccess` — use `import type` for type-only imports and treat indexed access
as possibly-`undefined`.
