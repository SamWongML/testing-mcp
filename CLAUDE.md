# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An LLM-driven API testing platform exposed over MCP. Tests are authored as typed, declarative
`defineTest`/`defineSuite` values, compiled to a normalized JSON manifest, and executed by a pure
in-house DAG engine. The result is rendered to Markdown / HTML / JUnit / an `llm_summary`.

## Session workflow — read before doing any phase work

The platform is built in sequential phases (P0–P11) tracked in `docs/PROGRESS.md`. Every session:

1. Open `docs/PROGRESS.md`, find the first phase not marked `✅ done`, and read its handoff notes —
   they are the only memory that crosses sessions.
2. Read that phase's section in `docs/implementation-plan.md`, then **only** the `docs/research.md`
   sections it references. `research.md` is ~30k tokens; never read it whole.
3. Verify the previous phase's exit-criteria commands still pass before building on it.
4. Build within the phase's file scope. Work belonging to a later phase → note it under that phase in
   `PROGRESS.md`; don't do it now.
5. Update `docs/PROGRESS.md` (status, checklist, handoff notes), then commit and push.

**Current state:** P0–P5 done; P6 (store — Postgres record + queue + artifacts) next.
`@atp/schema`, `@atp/engine`, `@atp/reporting`, `@atp/cli`, and `tools/compile` are
implemented, and a sample corpus lives in `tests/`; `store` and `mcp-server` are still
one-line stubs.

## Commands

```bash
pnpm install                 # Node 22+ required; `corepack enable` (pnpm 10.33 is pinned)
pnpm typecheck               # tsc --noEmit over packages/*/src + tools/*/src — the authoritative check
pnpm lint                    # eslint
pnpm test                    # vitest run (whole workspace)
pnpm format                  # prettier --write .   (Markdown is intentionally excluded)
pnpm compile                 # discovery → dist/manifest.json
pnpm atp list|run|validate   # local dev CLI over the tests/ corpus (P4)
```

CI (`.github/workflows/ci.yml`) runs — and must stay green on — install → typecheck → lint → test.

Running a subset of tests:

```bash
pnpm exec vitest run packages/engine/src/retry.test.ts   # a single file
pnpm exec vitest run -t "backoff"                        # by test-name substring
pnpm --filter @atp/engine test                           # a single package
```

## Architecture

**The pipeline.** Authored TypeScript (`defineTest`/`defineSuite`, which carry real functions) →
normalizer → normalized JSON **manifest** (fully serializable) → the **engine** executes it → a typed
`ExecutionResult` → renderers. The manifest — not the source files — is what the server loads at
runtime (ADR-003).

**Authored vs. normalized is the core mental model.** The Zod schemas exported from `@atp/schema`
describe the *normalized, serializable* form. The *authored* forms (types at the bottom of
`packages/schema/src/test.ts`) carry what cannot serialize: `fn` assertion predicates and a `params`
builder. The normalizer replaces each `fn` with `{ fnHash }` (a content hash) and the `params`
builder with a JSON Schema. Change a representation in `@atp/schema` first and let consumers adapt —
never fork the shape.

**Monorepo layout.** pnpm workspaces over `packages/*` and `tools/*`. Internal `@atp/*` packages
resolve to their `src/index.ts` via the `exports` field, so cross-package imports need no build step
in dev/test. To add a cross-package dependency, add `"@atp/x": "workspace:*"` to that package's
`dependencies` and run `pnpm install`. Dependency direction: `schema` ← `engine` ← everything else;
`tools/compile` builds on `schema` + `engine`. The package-responsibility table is in `README.md`.

**Execution model** (`packages/engine/src/runner.ts`). A **test** runs its steps sequentially — a
failed/errored step skips the rest, a cancel cascades. A **suite** is a topologically-scheduled
**DAG** over the same per-node runner, with independent branches running under a bounded concurrency
limit (default 8); a node whose dependency did not pass is `skipped`. Each node: resolve templates →
apply auth → send (undici) → assert → extract → publish, wrapped in per-step retry and
eventual-consistency polling, snapshotting a redacted request/response.

**Template variable scopes** resolved against the run context (`packages/engine/src/context.ts`):
`{{env.*}}`, `{{params.*}}`, `{{secrets.*}}`, `{{matrix.*}}`, `{{nodes.<id>.<var>}}` (deterministic
cross-node addressing), and `{{vars.*}}` (a flat last-writer-wins bag — reliable only within a single
dependency chain, not across parallel branches). Matrix expansion is plan-time (`matrix.ts`); the
runner executes one cell at a time.

## Invariants

These hold across all phases (ADR references point into `docs/research.md`):

- **Schema is the source of truth** — representation changes land in `@atp/schema` first (ADR-003).
- **The engine stays pure** — never import MCP or AWS code into `@atp/engine`.
- **Redact before persist** — any request/response snapshot passes `redact()` first.
- **Additive MCP tool surface** — never rename or remove a tool or field; add optional fields.
- **Stateless request path** — no cross-request memory in the MCP service (ADR-002).
- **Every run records `manifestHash` + `gitSha`.**

## Conventions

- TypeScript strict + ESM throughout. The base tsconfig sets `verbatimModuleSyntax`,
  `isolatedModules`, and `noUncheckedIndexedAccess`, so use `import type` for type-only imports and
  treat indexed access as possibly-`undefined`.
- Cheap structural guards live in the `defineX` helpers (fail fast where the value is authored);
  shape validation lives in Zod `.refine`s (fail at parse time). Ids are addressing keys (`needs`
  edges, `{{nodes.X.*}}` templates, manifest lookup) and are `.refine`d unique.
- **Test-file location matters.** Platform unit tests sit beside their source as
  `packages/**/src/**/*.test.ts` (and `tools/**/src/**/*.test.ts`) — exactly what `vitest.config.ts`
  matches. The future `tests/` corpus is *also* `*.test.ts` but is deliberately **not** matched by
  that config; keep platform unit tests under `src/`.

## Key docs

- `docs/research.md` — architecture rationale and ADRs (large; read only the sections a phase cites).
- `docs/implementation-plan.md` — the phase-by-phase plan with per-phase exit criteria.
- `docs/PROGRESS.md` — live status, checklists, and cross-session handoff notes.
- `README.md` — the package-responsibility map.
