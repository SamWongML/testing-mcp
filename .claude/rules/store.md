---
paths:
  - "packages/store/**/*.ts"
---

# `@atp/store` — Postgres persistence, queue, artifacts

Drizzle over Postgres, plus the AWS adapters. `runs.ts` (history), `queue.ts`
(claim/heartbeat/reap), `tasks.ts` (`TaskStateStore` + `PostgresTaskStore`), `manifests.ts`
(catalog snapshot), `artifacts.ts` (`ArtifactStore` + `LocalArtifactStore`), `audit.ts`,
`db/url.ts` (`resolveDatabaseUrl` — prefers `DATABASE_URL`, else derives one from the RDS
Secrets Manager JSON with percent-encoded credentials).

`aws/` holds the AWS adapters behind those same two seams: `dynamo-tasks.ts`,
`dynamo-idempotency.ts`, `s3-artifacts.ts`, and `select.ts` —
`createTaskStoreProvider(config)` / `createArtifactStore(config, dir)`. **Only `select.ts`
knows which backing is live**; callers ask the provider. `forDb(db)` exists because the
Postgres store must join the caller's *transaction* (that is what keeps create-task + enqueue
atomic); DynamoDB ignores the handle and reports `transactional: false`, which is how
`submitRun` knows to use the idempotency table instead.

**DynamoDB gotchas encoded in `aws/attributes.ts`:** `state`, `error`, and `ttl` are reserved
words — every expression must alias its names. TTL is epoch **seconds**. Writes go through
`UpdateItem` (not `PutItem`) so `created_at` survives a replacing `put` via `if_not_exists`;
reads use `ConsistentRead` so a stale replica cannot resurrect a cancelled run.

## Testing — read this before running or writing tests here

Integration tests are **gated on `ATP_TEST_DATABASE_URL`** (`db/test-db.ts`). Unset ⇒ the
suites `describe.skipIf` out so `pnpm test` stays green offline; the pure unit tests
(`artifacts`, `artifactKey`, `select`, `db/url`) always run. **A green `pnpm test` with no DB does not mean the
store paths ran** — say so rather than claiming verification.

```bash
docker compose -f docker-compose.dev.yml up -d   # Postgres 16 + dynamodb-local + MinIO
ATP_TEST_DATABASE_URL=postgres://… \
ATP_TEST_DYNAMO_ENDPOINT=http://localhost:8000 \
ATP_TEST_S3_ENDPOINT=http://localhost:9000 \
  pnpm --filter @atp/store test
```

The AWS suites gate the same way on `ATP_TEST_DYNAMO_ENDPOINT` / `ATP_TEST_S3_ENDPOINT`
(`aws/test-aws.ts`, also exported as `@atp/store/testing` for cross-package tests). Each
`makeTestTables()` / `makeTestBucket()` creates uniquely-named throwaway resources.

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
